'use strict';

if (angular && typeof(angular.module) === 'function') {
    angular.module('sync.storage', [])
        .factory('SyncStorageService', ['$timeout', function($timeout) {
            SyncStorage.angularTimeouts.push({
                timeout: $timeout,
                promise: null,
                trigger: function() {
                    if (this.promise) {
                        this.timeout.cancel(this.promise);
                        this.promise = null;
                    }

                    this.promise = this.timeout(function() {}, 25);
                }
            });

            return {};
        }]);
}

(function() {
    var CACHE_PREFIX = 'SyncStorage.Cache.';

    var initObject = function(object, key, readOnly) {
        if (object._object)
            return object;

        if (typeof(Object.defineProperties) === 'function') {
            Object.defineProperties(object, {
                '_object': {
                    value: true
                },
                '_key': {
                    value: key
                },
                _readOnly: {
                    value: !!readOnly,
                    writable: true
                }
            });
        }
        else {
            console.error("This browser doesn't implement Object.defineProperties!");
        }

        return object;
    };

    var initList = function(object, readOnly) {
        if (object._list)
            return object;

        if (typeof(Object.defineProperties) === 'function') {
            Object.defineProperties(object, {
                _list: {
                    value: true
                },
                _count: {
                    get: function() {
                        return Object.keys(object).length;
                    }
                },
                _readOnly: {
                    value: !!readOnly,
                    writable: true
                }
            });
        }
        else {
            console.error("This browser doesn't implement Object.defineProperties!");
        }

        return object;
    };

    var loadScript = function(url, callback) {
        var script = document.createElement('script');
        script.src = url;
        script.onload = callback;
        document.getElementsByTagName('head')[0].appendChild(script);
    };

    var instances = {};

    var loadFromLocalStorage = function(key, defaultValue) {
        if (typeof(localStorage[key]) === 'undefined')
            return defaultValue;

        return JSON.parse(localStorage[key]);
    };

    var parseHeader = function(header) {
        if (typeof(header) !== 'string') {
            console.log('couldn\'t decode header: ', header);
            return {};
        }

        var parts = header.match(/^([^:@]+)(?::(([^:@]+)(?::([^:@]+))?))?([@].*)?/);

        if (!parts) {
            console.log('couldn\'t decode header: ', header);
            return {};
        }

        return {
            full: header,
            packetType: parts[1],
            key: parts[2],
            type: parts[3],
            id: parts[4] || null,
            packetId: parts[5] || null
        };
    };

    var parseKey = function(key) {
        var parts = key.match(/^(([^:]+)(?::([^:@]+))?)([@].*)?/);

        return {
            full: key,
            key: parts[1],
            type: parts[2],
            id: parts[3] || null,
            packetId: parts[4] || null
        };
    };

    var instance = function(url, options) {
        var self = this;

        self.url = url;

        // TODO: deep observation
        var objects = {};

        var scheduleCacheUpdate = function(key) {
            var type = parseKey(key).type;

            var pending = scheduleCacheUpdate.pending;
            if (!pending)
                pending = scheduleCacheUpdate.pending = {};

            if (pending[type]) {
                clearTimeout(pending[type]);
                delete pending[type];
            }

            pending[type] = setTimeout(function() {
                delete pending[type];

                var string;

                var prefix = 'rw:';

                if (objects[type]._list) {
                    if (objects[type]._readOnly)
                        prefix = 'r:';
                    string = new SyncStorage.SyncStorageCsv().stringify(objects[type]);
                }
                else {
                    if (objects[type]._readOnly)
                        prefix = 'r:';
                    string = JSON.stringify(objects[type]);
                }

                if (string !== null && string.length > 0 && string !== 'null' && string !== '{}')
                    localStorage[CACHE_PREFIX + type] = prefix + string;
                else
                    delete localStorage[CACHE_PREFIX + type];
            }, 1000);
        };

        self.options = options || {};
        if (!self.options.handlers)
            self.options.handlers = {};

        self.transport = null;

        var requestedKeys = (self.options.preloadKeys) || [];

        if (!requestedKeys instanceof Array)
            requestedKeys = [requestedKeys];

        this.isConnected = function() {
            return !!self.transport;
        };

        var listeners = {};

        this.reset = function() {
            if (self.isConnected())
                self.transport.close();

            requestedKeys = [];

            // delete all objects in memory
            objects = {};

            listeners = {};

            // delete from local storage
            Object.keys(localStorage).forEach(function(key) {
                if (/^SyncStorage\.(Cache|SendQueue)/.test(key)) {
                    delete localStorage[key];
                }
            });
        };

        var sendQueue = loadFromLocalStorage('SyncStorage.SendQueue:' + self.url, {id:13330});

        var saveSendQueue = function() {
            // save the sendQueue to localStorage any time it changes
            localStorage['SyncStorage.SendQueue:' + self.url] = JSON.stringify(sendQueue);
        };

        this.transportInitialized = false;

        var addListener = function(key, listener) {
            var list = listeners[key] || (listeners[key] = []);
            list.push(listener);
            var parent = key.replace(/:.*$/, '');
            if (key !== parent)
                addListener(parent, listener);
        };

        this.send = function(message, listener) {
            message.id = (sendQueue.id++).toString(36);

            var json = JSON.stringify(message);

            if (message.queue !== false)
                sendQueue[message.id] = json;

            if (typeof(listener) === 'function') {
                var packetId = '@' + message.id;
                addListener(packetId, listener);
            }

            if (self.transport)
                self.transport.send(json);

            if (message.queue !== false)
                saveSendQueue();
        };

        var removeListener = function(key, listener) {
            var list = listeners[key];
            if (list) {
                var index = list.indexOf(listener);
                if (index > -1)
                    list.splice(index, 1);
            }
        };

        this.set = function(key, value, listener) {
            if (value._list) {
                console.log('how did we get here?');
                return;
            }

            // TODO: if value is null we should probably delete
            if (typeof(value) === 'object' && !value._object)
                initObject(value, key);

            if (requestedKeys.indexOf(key) === -1)
                requestedKeys.push(key);

            if (objects[key])
                value = updateObject(objects[key], value);
            else
                objects[key] = value;

            this.send({
                cmd: 'set',
                key: key,
                value: value
            }, listener);

            scheduleCacheUpdate(key);

            return value;
        };

        this['create'] = function(key, value, listener) {
            self.send({
                cmd: 'create',
                key: key,
                value: value
            }, listener);
        };

        this['delete'] = function(key, listener) {
            if (key._key)
                key = key._key;

            if (requestedKeys.indexOf(key) === -1)
                requestedKeys.push(key);

            self.send({
                cmd: 'delete',
                key: key
            }, listener);

            scheduleCacheUpdate(key);
        };

        var parse = function(key, string, readOnly) {
            if (!string || string === 'null')
                return null;

            if (string.substring(0, 2) === 'r:') {
                readOnly = true;
                string = string.substring(2);
            }
            else if (string.substring(0, 3) === 'rw:') {
                readOnly = false;
                string = string.substring(3);
            }

            if (/^\s*[{[]/.test(string)) {
                var value = string !== 'null' ? JSON.parse(string) : {};
                initObject(value, key, readOnly);
                return value;
            }

            var list = initList({}, readOnly);

            var pk = null;
            var fields = null;

            var count = 0;

            new SyncStorage.SyncStorageCsv().parse(string, function(header) {
                fields = header;

                fields.forEach(function(field, i) {
                    if (field.toLowerCase() == 'id') {
                        pk = i;
                    }
                });
            }, function(row) {
                var object = {};

                // copy data from row into object
                fields.forEach(function(field, i) {
                    object[field] = row[i];
                });

                var id = pk !== null ? row[pk] : count;

                initObject(object, key + ':' + id, readOnly);

                list[id] = object;

                count++;
            });

            return list;
        };

        this.get = function(key, listener, update) {
            if (typeof(update) === 'function')
                addListener(key, update);

            var alreadyRequested = requestedKeys.indexOf(key) !== -1;

            if (!alreadyRequested) {
                if (key.indexOf(':') !== -1)
                    alreadyRequested = requestedKeys.indexOf(key.replace(/:.*/, '')) !== -1;

                if (!alreadyRequested)
                    requestedKeys.push(key);
            }

            key = parseKey(key);

            var container = objects[key.type];

            var containerExisted = typeof(container) !== 'undefined';

            var callUpdateImmediately = true;

            if (!containerExisted) {
                // try to find it in localStorage
                var cached = localStorage[CACHE_PREFIX + key.type];

                if (cached) {
                    objects[key.type] = container = parse(key.type, cached);
                }
                else {
                    objects[key.type] = container = {};
                    callUpdateImmediately = false;
                }
            }

            var value = container;
            var valueExisted = true;

            if (key.id !== null) {
                value = container[key.id];

                if (typeof(value) === 'undefined' || value === null) {
                    valueExisted = false;
                    value = container[key.id] = initObject({}, key.key);
                }
                else {
                    valueExisted = true;
                }
            }

            if (!containerExisted || !valueExisted || (key.id === null && !container._list) || !alreadyRequested) {
                setTimeout(function() {
                    // ask the server to send the value
                    self.send({cmd: 'get', key: key.key}, listener);
                }, 0);
            }

            if (callUpdateImmediately && typeof(update) === 'function') {
                update(key.key, value);
            }

            return value;
        };

        var updateObject = function(object, update) {
            if (update instanceof Array && (!object || object instanceof Array)) {
                if (object instanceof Array)
                    object.length = 0;
                else
                    object = [];
                object.splice.apply(object, [0, 0].concat(update));
                return object;
            }

            if (update._list && !object._list)
                initList(object);
            else if (update._object && !object._object)
                initObject(object, update._key, update._readOnly);

            if (update._list)
                object._readOnly = update._readOnly;

            var oldKeys = Object.keys(object);

            oldKeys.forEach(function(k) {
                if (typeof(update[k]) === 'undefined') {
                    switch (typeof(object[k])) {
                        case 'function':
                            // don't delete functions
                            break;
                        default:
                            // old key doesn't exist in new object so remove it
                            delete object[k];
                    }
                }
            });

            var newKeys = Object.keys(update);

            newKeys.forEach(function(k) {
                var oldValue = object[k];
                var newValue = update[k];

                // don't copy functions
                if (typeof(oldValue) === 'function' || typeof(newValue) === 'function')
                    return;

                if (oldValue !== null && typeof(oldValue) === 'object')
                    updateObject(oldValue, newValue);
                else if (oldValue !== newValue)
                    object[k] = newValue;
            });

            return object;
        };

        this.initTransport = function() {
            if (typeof(SockJS) === 'undefined')
                return;

            this.transportInitialized = true;

            var sjs = new SockJS(self.url);

            var retryTimeout = 5000;

            sjs.onopen = function() {
                console.log('connected to server ' + self.url);
                self.transport = sjs;

                retryTimeout = 0;

                var resubscribe = function() {
                    var requested = [];

                    Object.keys(sendQueue).sort().forEach(function(id) {
                        if (id !== 'id') {
                            var packet = sendQueue[id];
                            var message = JSON.parse(packet);

                            if (message.key && requested.indexOf(message.key) !== -1) {
                                delete sendQueue[id];
                                saveSendQueue();
                                return;
                            }

                            requested.push(message.key);

                            self.transport.send(packet);
                        }
                    });

                    requestedKeys.forEach(function(key) {
                        key = parseKey(key).key;

                        var check = key.split(':');

                        while (check.length > 0) {
                            if (requested.indexOf(check.join(':')))
                                return;

                            check.length = check.length - 1;
                        }

                        requested.push(key);

                        self.transport.send(JSON.stringify({cmd: 'get', key: key}));
                    });
                };

                if (typeof(self.options.handlers.connect) === 'function')
                    self.options.handlers.connect.call(self, resubscribe);
                else
                    resubscribe();
            };

            sjs.onclose = function() {
                console.log('disconnected from server ' + self.url);

                if (typeof(self.options.handlers.disconnect) === 'function')
                    self.options.handlers.disconnect.call(self);

                self.transport = null;
                window.setTimeout(self.initTransport, retryTimeout);
            };

            var notifyListeners = function(header, packet) {
                var list;

                if (packet && packet.data && packet.type === 'message') {
                    packet.parseJSON = function () {
                        var lf = packet.data.indexOf('\n');
                        if (lf === -1)
                            return null;

                        return JSON.parse(packet.data.substring(lf + 1));
                    };
                }

                if (header.key) {
                    list = listeners[header.key];
                    if (list) {
                        list.forEach(function (listener) {
                            listener.call(self, header, packet);
                        });
                    }
                }

                if (header.packetId) {
                    list = listeners[header.packetId];

                    if (list) {
                        list.forEach(function(listener) {
                            listener.call(self, header, packet);
                        });

                        delete listeners[header.packetId];
                    }
                }
            };

            var handleIncomingData = function(header, string, readOnly) {
                var update = parse(header.type, string, readOnly);

                if (!objects[header.type])
                    objects[header.type] = {};

                if (header.id !== null) {
                    if (update && update._list) {
                        update = update[header.id];

                        if (objects[header.type]._list)
                            initList(objects[header.type], readOnly);
                    }

                    if (update === null || typeof(update) === 'undefined') {
                        delete objects[header.type][header.id];
                    }
                    else {
                        if (objects[header.type][header.id])
                            updateObject(objects[header.type][header.id], update);
                        else
                            objects[header.type][header.id] = update;
                    }
                }
                else {
                    if (update === null)
                        update = initObject({}, header.type, readOnly);

                    updateObject(objects[header.type], update);
                }

                scheduleCacheUpdate(header.type);

                // tell angular to do a dirty check
                SyncStorage.angularTimeouts.forEach(function(timeout) {
                    timeout.trigger();
                });

                notifyListeners(header, header.id !== null ? objects[header.type][header.id] : objects[header.type]);
            };

            sjs.onmessage = function(e) {
                if (self.options.handlers.rawMessage && self.options.handlers.rawMessage.call(self, e))
                    return;

                if (typeof(e.data) === 'string') {
                    var string = e.data;
                    var p = 0, l = string.length;
                    while (p <= l && string.charAt(p++) != '\n');

                    var header = parseHeader(string.substring(0, p - 1));
                    var body = string.substring(p);

                    if (header.packetType === 'error')
                        header.error = JSON.parse(body);

                    if ((self.options.handlers[header.packetType] && self.options.handlers[header.packetType].call(self, header, body))) {
                        notifyListeners(header, e);
                    }
                    else {
                        switch (header.packetType) {
                            case 'ack':
                                if (header.packetId) {
                                    var id = header.packetId.substring(1);
                                    if (sendQueue[id]) {
                                        delete sendQueue[id];
                                        saveSendQueue();
                                    }
                                }
                                else {
                                    console.log('missing packet id for ', header);
                                }
                                break;
                            case 'r':
                                handleIncomingData(header, body, true);
                                break;
                            case 'rw':
                                handleIncomingData(header, body);
                                break;
                            case 'error':
                                console.error(header.error);
                            default:
                                notifyListeners(header, e);
                        }
                    }
                }
            };
        };

        this.initTransport();
    };

    if (typeof(SockJS) === 'undefined') {
        loadScript('http://cdn.sockjs.org/sockjs-0.3.min.js', function() {
            var urls = Object.keys(instances);
            urls.forEach(function(url) {
                var instance = instances[url];

                if (!instance.transportInitialized)
                    instance.initTransport();
            });
        });
    }

    var defaultEndpoint = location.origin.replace(/:\d+$/, '')+':8081/sync-storage';

    window.SyncStorage = {
        angularTimeouts: [],

        setDefaultEndpoint: function(url) {
            defaultEndpoint = url;
        },

        connect: function() {
            var url = null;
            var options = null;
            var arg;

            for (var i = 0, l = arguments.length; i < l; i++) {
                arg = arguments[i];
                if (arg === null)
                    continue;

                switch (typeof(arg)) {
                    case 'string':
                        url = arg;
                        break;
                    case 'object':
                        options = arg;
                        break;
                }
            }

            if (!url)
                url = defaultEndpoint;

            if (!instances[url])
                instances[url] = new instance(url, options);
            else if (options) {
                // TODO: copy changes into existing options
            }

            return instances[url];
        },

        get: function() {
            var instance = this.connect();
            return instance.get.apply(instance, arguments);
        },

        set: function() {
            var instance = this.connect();
            return instance.set.apply(instance, arguments);
        },

        create: function() {
            var instance = this.connect();
            return instance.create.apply(instance, arguments);
        },

        'delete': function() {
            var instance = this.connect();
            return instance.delete.apply(instance, arguments);
        },

        reset: function() {
            var instance = this.connect();
            return instance.reset.apply(instance, arguments);
        },

        isConnected: function() {
            var instance = this.connect();
            return instance.isConnected.call(instance);
        }
    };
})();
