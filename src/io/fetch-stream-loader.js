/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Log from '../utils/logger.js';
import Browser from '../utils/browser.js';
import {BaseLoader, LoaderStatus, LoaderErrors} from './loader.js';
import {RuntimeException} from '../utils/exception.js';

/* fetch + stream IO loader. Currently working on chrome 43+.
 * fetch provides a better alternative http API to XMLHttpRequest
 *
 * fetch spec   https://fetch.spec.whatwg.org/
 * stream spec  https://streams.spec.whatwg.org/
 */
class FetchStreamLoader extends BaseLoader {

    static isSupported() {
        try {
            // fetch + stream is broken on Microsoft Edge. Disable for now.
            // see https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/8196907/
            return (self.fetch && self.ReadableStream && !Browser.msedge);
        } catch (e) {
            return false;
        }
    }

    constructor(seekHandler) {
        super('fetch-stream-loader');
        this.TAG = this.constructor.name;

        this._seekHandler = seekHandler;
        this._needStash = true;

        this._requestAbort = false;
        this._contentLength = null;
        this._receivedLength = 0;
    }

    destroy() {
        if (this.isWorking()) {
            this.abort();
        }
        super.destroy();
    }

    open(dataSource, range) {
        this._dataSource = dataSource;
        this._range = range;

        let seekConfig = this._seekHandler.getConfig(dataSource.url, range);

        let headers = new self.Headers();

        if (typeof seekConfig.headers === 'object') {
            let configHeaders = seekConfig.headers;
            for (let key in configHeaders) {
                if (configHeaders.hasOwnProperty(key)) {
                    headers.append(key, configHeaders[key]);
                }
            }
        }

        let url = seekConfig.url;
        let params = {
            method: 'GET',
            headers: headers,
            mode: 'cors',
            cache: 'default'
        };

        // cors is enabled by default
        if (dataSource.cors === false) {
            // no-cors means 'disregard cors policy', which can only be used in ServiceWorker
            params.mode = 'same-origin';
        }

        // withCredentials is disabled by default
        if (dataSource.withCredentials) {
            params.credentials = 'include';
        }

        this._status = LoaderStatus.kConnecting;
        self.fetch(url, params).then((res) => {
            if (this._requestAbort) {
                this._requestAbort = false;
                this._status = LoaderStatus.kIdle;
                return;
            }
            if (res.ok && (res.status >= 200 && res.status <= 299)) {
                let lengthHeader = res.headers.get('Content-Length');
                if (lengthHeader != null) {
                    this._contentLength = parseInt(lengthHeader);
                    if (this._contentLength !== 0) {
                        if (this._onContentLengthKnown) {
                            this._onContentLengthKnown(this._contentLength);
                        }
                    }
                }
                return this._pump.call(this, res.body.getReader());
            } else {
                this._status = LoaderStatus.kError;
                if (this._onError) {
                    this._onError(LoaderErrors.HTTP_STATUS_CODE_INVALID, {code: res.status, msg: res.statusText});
                } else {
                    throw new RuntimeException('FetchStreamLoader: Http code invalid, ' + res.status + ' ' + res.statusText);
                }
            }
        }).catch((e) => {
            this._status = LoaderStatus.kError;
            if (this._onError) {
                this._onError(LoaderErrors.EXCEPTION, {code: -1, msg: e.message});
            } else {
                throw e;
            }
        });
    }

    abort() {
        this._requestAbort = true;
    }

    _pump(reader) {  // ReadableStreamReader
        return reader.read().then((result) => {
            if (result.done) {
                this._status = LoaderStatus.kComplete;
                if (this._onComplete) {
                    this._onComplete(this._range.from, this._range.from + this._receivedLength - 1);
                }
            } else {
                if (this._requestAbort === true) {
                    this._requestAbort = false;
                    this._status = LoaderStatus.kComplete;
                    return reader.cancel();
                }

                this._status = LoaderStatus.kBuffering;

                let chunk = result.value.buffer;
                let byteStart = this._range.from + this._receivedLength;
                this._receivedLength += chunk.byteLength;

                if (this._onDataArrival) {
                    this._onDataArrival(chunk, byteStart, this._receivedLength);
                }

                return this._pump(reader);
            }
        }).catch((e) => {
            this._status = LoaderStatus.kError;
            let type = 0;
            let info = null;

            if (e.code === 19 && // NETWORK_ERR
                (this._contentLength === null ||
                (this._contentLength !== null && this._receivedLength < this._contentLength))) {
                type = LoaderErrors.EARLY_EOF;
                info = {code: e.code, msg: 'Fetch stream meet Early-EOF'};
            } else {
                type = LoaderErrors.EXCEPTION;
                info = {code: e.code, msg: e.message};
            }

            if (this._onError) {
                this._onError(type, info);
            } else {
                throw new RuntimeException(info.msg);
            }
        });
    }

}

export default FetchStreamLoader;