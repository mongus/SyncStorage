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

    var instance = function(url, options) {
        var self = this;

        self.url = url;

        // TODO: deep observation
        var objects = {};

        var scheduleCacheUpdate = function(key) {
            var type = key.split(':')[0];

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

                if (string !== null && string.length > 0 && string !== 'null')
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

        this.reset = function() {
            if (self.transportInitialized)
                self.transport.close();

            requestedKeys = [];

            // delete all objects in memory
            Object.keys(objects).forEach(function(key) {
                delete objects[key];
            });

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

        this.send = function(message) {
            message.id = (sendQueue.id++).toString(36);

            var json = JSON.stringify(message);

            sendQueue[message.id] = json;

            if (self.transport)
                self.transport.send(json);

            saveSendQueue();
        };

        this.set = function(key, value) {
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
            });

            scheduleCacheUpdate(key);

            return value;
        };

        this['delete'] = function(key) {
            if (key._key)
                key = key._key;

            if (requestedKeys.indexOf(key) === -1)
                requestedKeys.push(key);

            this.send({
                cmd: 'delete',
                key: key
            });

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

        var listeners = {};

        var addListener = function(key, listener) {
            var list = listeners[key];
            if (!list)
                listeners[key] = list = [];
            list.push(listener);
            var parent = key.replace(/:.*$/, '');
            if (key !== parent)
                addListener(parent, listener);
        };

        this.get = function(key, listener) {
            if (typeof(listener) === 'function')
                addListener(key, listener);

            if (requestedKeys.indexOf(key) === -1)
                requestedKeys.push(key);

            // TODO: make filter work
            var filter = null;

            var arg;

            for (var i = 1, l = arguments.length; i < l; i++) {
                arg = arguments[i];
                switch (typeof(arg)) {
                    case 'object':
                        filter = arg;
                        break;
                }
            }

            var parts = key.split(':', 2);
            var type = parts[0];
            var id = parts.length >= 2 ? parts[1] : null;

            var container = objects[type];

            var containerExisted = typeof(container) !== 'undefined';

            var callListenerImmediately = true;

            if (!containerExisted) {
                // try to find it in localStorage
                var cached = localStorage[CACHE_PREFIX + type];

                if (cached) {
                    objects[type] = container = parse(type, cached);
                }
                else {
                    objects[type] = container = {};
                    callListenerImmediately = false;
                }
            }

            var value = container;
            var valueExisted = true;

            if (id !== null) {
                value = container[id];

                if (typeof(value) === 'undefined' || value === null) {
                    valueExisted = false;
                    value = container[id] = initObject({}, key);
                }
                else {
                    valueExisted = true;
                }
            }

            if (!containerExisted || !valueExisted) {
                setTimeout(function() {
                    // ask the server to send the value
                    self.send({cmd: 'get', key: key});
                }, 0);
            }

            if (callListenerImmediately && typeof(listener) === 'function') {
                listener(key, value);
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
                console.log('connected to server');
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
                console.log('disconnected from server');

                if (typeof(self.options.handlers.disconnect) === 'function')
                    self.options.handlers.disconnect.call(self);

                self.transport = null;
                window.setTimeout(self.initTransport, retryTimeout);
            };

            var handleIncomingData = function(header, string, readOnly) {
                var parts = header.match(/^([^:]+):(([^:]+)(?::([^:]+))?)/);

                var key = parts[2];
                var type = parts[3];
                var id = parts[4] || null;

                var update = parse(type, string, readOnly);

                if (!objects[type])
                    objects[type] = {};

                if (id !== null) {
                    if (update && update._list) {
                        update = update[id];

                        if (objects[type]._list)
                            initList(objects[type], readOnly);
                    }

                    if (update === null || typeof(update) === 'undefined') {
                        delete objects[type][id];
                    }
                    else {
                        if (objects[type][id])
                            updateObject(objects[type][id], update);
                        else
                            objects[type][id] = update;
                    }
                }
                else {
                    if (update === null)
                        update = initObject({}, type, readOnly);

                    updateObject(objects[type], update);
                }

                scheduleCacheUpdate(type);

                // tell angular to do a dirty check
                SyncStorage.angularTimeouts.forEach(function(timeout) {
                    timeout.trigger();
                });

                var list = listeners[key];
                if (list) {
                    list.forEach(function(listener) {
                        listener(key, id !== null ? objects[type][id] : objects[type]);
                    });
                }
            };

            sjs.onmessage = function(e) {
                if (self.options.handlers.rawMessage && self.options.handlers.rawMessage.call(self, e))
                    return;

                if (typeof(e.data) === 'string') {
                    var string = e.data;
                    var p = 0, l = string.length;
                    while (p <= l && string.charAt(p++) != '\n');

                    var header = string.substring(0, p - 1);
                    var body = string.substring(p);

                    var parts = header.split(':');

                    var messageType = parts[0];

                    if (self.options.handlers[messageType] && self.options.handlers[messageType].call(self, header, body))
                        return;

                    switch (messageType) {
                        case 'ack':
                            var id = parts[1];
                            if (sendQueue[id]) {
                                delete sendQueue[id];
                                saveSendQueue();
                            }
                            break;
                        case 'r':
                            handleIncomingData(header, body, true);
                            break;
                        case 'rw':
                            handleIncomingData(header, body);
                            break;
                        case 'error':
                            console.error(JSON.parse(body));
                            break;
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

    window.SyncStorage = {
        angularTimeouts: [],

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
                url = location.origin.replace(/:\d+$/, '')+':6580/sync-storage';

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

        'delete': function() {
            var instance = this.connect();
            return instance.delete.apply(instance, arguments);
        },

        reset: function() {
            var instance = this.connect();
            return instance.reset.apply(instance, arguments);
        }
    };
})();
