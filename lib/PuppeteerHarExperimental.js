const fs = require('fs');
const { promisify } = require('util');
const assert = require('assert');
const { harFromMessages } = require('chrome-har');
const logger = require('winston');

// event types to observe
const page_observe = [
    'Page.loadEventFired',
    'Page.domContentEventFired',
    'Page.frameStartedLoading',
    'Page.frameAttached',
    'Page.frameScheduledNavigation',
];

const network_observe = [
    'Network.requestWillBeSent',
    'Network.requestServedFromCache',
    'Network.dataReceived',
    'Network.responseReceived',
    'Network.resourceChangedPriority',
    'Network.loadingFinished',
    'Network.loadingFailed',
];

class PuppeteerHar {

    /**
     * @param {object} page
     */
    constructor(page) {
        this.page = page;
        this.mainFrame = this.page.mainFrame();
        this.inProgress = false; 
        this.bodies={};
        this.errors={}
        this.cleanUp();
    }

    /**
     * @returns {void}
     */
    cleanUp() {
        this.network_events = [];
        this.page_events = [];
        this.response_body_promises = [];
    }

    /**
     * @param {{path: string}=} options
     * @return {Promise<void>}
     */
    async start({ path, saveResponse, captureMimeTypes, useFetch } = {}) {
        this.inProgress = true;
        this.useFetch = useFetch || false;
        this.saveResponse = saveResponse || false;

        assert(!this.useFetch || this.saveResponse);

        this.captureMimeTypes = captureMimeTypes || ['text/html', 'application/json'];
        this.path = path;
        this.client = await this.page.target().createCDPSession();
        await this.client.send('Page.enable');
        await this.client.send('Network.enable');
        if  (this.useFetch) {
           await this.client.send('Fetch.enable', {
                  patterns: [{ requestStage: "Response" }]
            });
        
        
            await this.client.on('Fetch.requestPaused', params=>{
                //console.log(params);
                
                const {requestId,networkId }= params;
                const rscOk=params.responseStatusCode == null || (params.responseStatusCode<300 || params.responseStatusCode>=400);
                if (params.responseHeaders!=null && rscOk  ){
                    try {
                        if (this.inProgress&& (params.responseErrorReason !=null || params.responseStatusCode !=null)) {
                            const promise = this.client.send('Fetch.getResponseBody',{requestId}).catch(ex=>{
                                console.log(params);
                                logger.error("Fetch.getResponseBody failed"+ `${ex.message}, stack trace - ${ex.stack}`);
                            });                            
                            this.bodies[networkId] = promise;
                            this.response_body_promises.push(promise);
                        } else {
                            if(this.inProgress) {
                                logger.error("This shuold not happen (we are filtering only Response request stage)");
                            }
                        }
                    } catch (reason){
                        this.errors[networkId]=reason

                    }
                    this.client.send('Fetch.continueRequest',{requestId});
                } else {
                    this.client.send('Fetch.continueRequest',{requestId});
            }
                
            })
        }
        page_observe.forEach(method => {
            this.client.on(method, params => {
                if (!this.inProgress) {
                    return;
                }
                this.page_events.push({ method, params });
            });
        });
        network_observe.forEach(method => {
            this.client.on(method, params => {
                if (!this.inProgress) {
                    return;
                }
                this.network_events.push({ method, params });
                //if (method=='Network.dataReceived'){
                //    console.log('data received');
                //}

                if (this.saveResponse && method == 'Network.responseReceived') {
                    const response = params.response;
                    const requestId = params.requestId;
                    
                    // Response body is unavailable for redirects, no-content, image, audio and video responses
                    if (this.inProgress &&
                        response.status !== 204 &&
                        response.headers.location == null &&
                        this.captureMimeTypes.includes(response.mimeType)
                    ) {
                        if (this.useFetch) { 
			                if (requestId in this.bodies) {
                                
                                this.bodies[requestId].then((responseBody) => {
                                // Set the response so `chrome-har` can add it to the HAR
                                params.response.encoding='base64';
                                params.response.body = new Buffer.from(
                                    responseBody.body,
                                    responseBody.base64Encoded ? 'base64' : undefined,
                                ).toString('base64');
                            }, (reason) => {
                                params.response.body="Fetch failed";
                                console.log("body fetch failed ");                        
                             }).catch(reason=>{
                                params.response.body="Fetch failed2";
                                console.log("body fetch failed2 ");
                             });
			                } else if (requestId in this.errors) {
                                params.response.body = this.errors[requestId].toString
                            }
                        } else {

                            const promise = this.client.send(
                                'Network.getResponseBody', { requestId },
                            ).then((responseBody) => {
                                // Set the response so `chrome-har` can add it to the HAR
                                params.response.body = new Buffer.from(
                                    responseBody.body,
                                    responseBody.base64Encoded ? 'base64' : undefined,
                                ).toString();
                            }, (reason) => {
                                console.log("body fetch failed");
                                // Resources (i.e. response bodies) are flushed after page commits
                                // navigation and we are no longer able to retrieve them. In this
                                // case, fail soft so we still add the rest of the response to the
                                // HAR. Possible option would be force wait before navigation...
                            });
                            this.response_body_promises.push(promise);
                    }
                } 
            }           
            });
        });
    }

    /**
     * @returns {Promise<void|object>}
     */
    async stop() {
        this.inProgress = false; 
        await Promise.all(this.response_body_promises);
        await this.client.detach();
        const har = harFromMessages(
            this.page_events.concat(this.network_events),
            {includeTextFromResponseBody: this.saveResponse}
        );
        this.cleanUp();
        if (this.path) {
            await promisify(fs.writeFile)(this.path, JSON.stringify(har));
        } else {
            return har;
        }
    }
}

module.exports = PuppeteerHar;
