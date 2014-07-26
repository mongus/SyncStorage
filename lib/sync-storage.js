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

function Observable() {
    if (typeof(Object.defineProperty) === 'function') {
        Object.defineProperty(this, '_key', { value: null, writable: true });
    }
    else {
        this._key = null;
    }

    this.init = function(key, observer) {
        this._key = key;
        var object = this;
        setTimeout(function() {
            delete object.init;
            Object.observe(object, observer);
        }, 0);

        return this;
    };

    return this;
}

(function() {
    var CACHE_PREFIX = 'SyncStorage.Cache.';

    function transmogrify(object, newClass) {
        newClass.call(object);
        object.__proto__ = newClass.prototype;
        return object;
    }

    Observable.mutate = function(target, key, observer) {
        transmogrify(target, Observable);
        target.init(key, observer);
        return target;
    };

    function List() {
        if (typeof(Object.defineProperty) === 'function') {
            Object.defineProperty(this, 'count', {
                get: function() {
                    return Object.keys(this).length;
                }
            });
        }
    }

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

                if (objects[type] instanceof List)
                    string = new SyncStorage.SyncStorageCsv().stringify(objects[type]);
                else
                    string = JSON.stringify(objects[type]);

                if (string !== null && string.length > 0 && string !== 'null')
                    localStorage[CACHE_PREFIX + type] = string;
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

            Object.keys(objects).forEach(function(key) {
                delete objects[key];
            });

            Object.keys(localStorage).forEach(function(key) {
                if (/^SyncStorage\.(Cache|SendQueue)/.test(key)) {
                    delete localStorage[key];
                }
            });
        };

        var sendQueue = loadFromLocalStorage('SyncStorage.SendQueue:' + self.url, {id:13330});

        Object.observe(sendQueue, function() {
            // save the sendQueue to localStorage any time it changes
            localStorage['SyncStorage.SendQueue:' + self.url] = JSON.stringify(sendQueue);
        });

        this.transportInitialized = false;

        var send = function(message) {
            message.id = (sendQueue.id++).toString(36);

            var json = JSON.stringify(message);

            sendQueue[message.id] = json;

            if (self.transport)
                self.transport.send(json);
        };

        var observer = function(changes) {
            changes.forEach(function(change) {
                var object = change.object;

                // don't worry about changes to properties if the value is/was a function
                if (typeof(object[change.name]) === 'function' || typeof(change.oldValue) === 'function')
                    return;

                var key = object._key;

                self.set(key, object);
            });
        };

        this.set = function(key, value) {
            if (value instanceof List) {
                console.log('how did we get here?');
                return;
            }

            if (typeof(value) === 'object' && !(value instanceof Observable)) {
                // we need to make this observable so we can handle updates automagically
                Observable.mutate(value, key, observer);
            }

            if (requestedKeys.indexOf(key) === -1)
                requestedKeys.push(key);

            if (objects[key])
                value = updateObject(objects[key], value);
            else
                objects[key] = value;

            send({
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

            send({
                cmd: 'delete',
                key: key
            });

            scheduleCacheUpdate(key);
        };

        var ListManager = {
            getClassName: function(label) {
                // get rid of special id if there is one
                var name = label.replace(/[|].*$/, '');
                // convert first letter of each word to uppercase
                name = name.replace(/\b(\w)/g, function(f) { return f.toUpperCase(); });
                name = name.replace('-', '');
                return name;
            },
            createClass: function(label) {
                if (window[label])
                    return;

                var name = ListManager.getClassName(label);

                var type = eval.call(window, 'function ' + name + '() {Observable.call(this);};' + name + ';');

                type.prototype = Object.create(Observable.prototype);
                var prototype = type.prototype;
                prototype.constructor = type;
            }
        };

        var parse = function(key, string) {
            if (!string || string === 'null')
                return {};

            var type = ListManager.getClassName(key);

            if (/^\s*[{[]/.test(string)) {
                var value = string !== 'null' ? JSON.parse(string) : {};
                Observable.mutate(value, key, observer);
                return value;
            }

            var list = new List();

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

                ListManager.createClass(type);
            }, function(row) {
                var object = eval('new ' + type + '();');

                // copy data from row into object
                fields.forEach(function(field, i) {
                    object[field] = row[i];
                });

                var id = pk !== null ? row[pk] : count;

                object.init(key + ':' + id, observer);

                list[id] = object;

                count++;
            });

            return list;
        };

        this.get = function(key) {
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
            var id = parts.length === 2 ? parts[1] : null;

            var container = objects[type];

            var containerExisted = !!container;

            if (!container) {
                objects[type] = container = {};

                // try to find it in localStorage
                var cached = localStorage[CACHE_PREFIX + type];

                if (cached) {
                    var update = parse(type, cached);
                    updateObject(container, update);
                }
            }

            var value = container;
            var valueExisted = !!value;

            if (id !== null) {
                value = container[id];

                if (!value) {
                    valueExisted = false;
                    value = container[id] = new Observable();
                    value.init(key, observer);
                }
                else {
                    valueExisted = true;
                }
            }
            
            if (!containerExisted || !valueExisted) {
                setTimeout(function() {
                    // ask the server to send the value
                    send({cmd: 'get', key: key});
                }, 0);
            }

            return value;
        };

        var updateObject = function(object, update) {
            if ((update instanceof Observable) && !(object instanceof Observable))
                Observable.mutate(object, update._key, observer);
            else if (update instanceof List && !(object instanceof List))
                transmogrify(object, List);

            // ignore changes we make in here so we don't get stuck in a loop
            if (object instanceof Observable)
                Object.unobserve(object, observer);

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

            // start watching changes again
            if (object instanceof Observable)
                Object.observe(object, observer);

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

                            if (message.key && requested.indexOf(message.key) !== -1)
                                return;

                            requested.push(message.key);

                            self.transport.send(packet);
                        }
                    });

                    requestedKeys.forEach(function(key) {
                        if (requested.indexOf(key) !== -1)
                            return;

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

            var handleIncomingData = function(header, string) {
                var parts = header.match(/^([^:]+):(([^:]+)(?::([^:]+))?)/);

                var key = parts[2];
                var type = parts[3];
                var id = parts[4] || null;

                var update = parse(type, string);

                if (update && !(update instanceof List) && !(update instanceof Observable)) {
                    Observable.mutate(update, key, observer);
                }

                if (!objects[type])
                    objects[type] = {};

                if (id !== null) {
                    if (update instanceof List) {
                        update = update[id];

                        if (!(objects[type] instanceof List))
                            transmogrify(objects[type], List);
                    }

                    if (update === null) {
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
                    updateObject(objects[type], update);
                }

                scheduleCacheUpdate(type);

                // tell angular to do a dirty check
                SyncStorage.angularTimeouts.forEach(function(timeout) {
                    timeout.trigger();
                });
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

                    var type = parts[0];

                    if (self.options.handlers[type] && self.options.handlers[type].call(self, header, body))
                        return;

                    switch (type) {
                        case 'ack':
                            var id = parts[1];
                            if (sendQueue[id])
                                delete sendQueue[id];
                            break;
                        case 'data':
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
