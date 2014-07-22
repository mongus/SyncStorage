'use strict';

function Observable() {
    if (typeof(Object.defineProperties) === 'function') {
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
    }
}

Observable.mutate = function(target, key, observer) {
    Observable.call(target);
    target.__proto__ = Observable.prototype;
    target.constructor = Observable;
    target.init(key, observer);
    return target;
};

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

                    this.promise = this.timeout(function() {}, 10)
                }
            });

            return {};
        }]);
}

(function() {
    function List() {
        this.count = function() {
            return Object.keys(this).length;
        };
    }

    List.mutate = function(target) {
        List.call(target);
        target.__proto__ = List.prototype;
        target.constructor = List;
        return target;
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
        // TODO: need to add code to save to local storage after update
        // TODO: deep observation
        var lists = {};
        var objects = {};

        options = options || {};
        var transport;
        var self = this;

        var requestedKeys = (options && options.preloadKeys) || [];

        if (!requestedKeys instanceof Array)
            requestedKeys = [requestedKeys];

        var sendQueue = loadFromLocalStorage('SyncStorage.SendQueue.' + url, {id:13330});

        Object.observe(sendQueue, function() {
            // save the sendQueue to localStorage any time it changes
            localStorage['SyncStorage.SendQueue.' + url] = JSON.stringify(sendQueue);
        });

        this.transportInitialized = false;

        var send = function(message) {
            message.id = (sendQueue.id++).toString(36);

            var json = JSON.stringify(message);

            sendQueue[message.id] = json;

            if (transport)
                transport.send(json);
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
                Observable.mutate(value, type, observer);
                return value;
            }

            var list = new List();

            var pk = null;
            var fields = null;

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

                var id = row[pk];

                object.init(key + ':' + id, observer);

                list[id] = object;
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

            var container = lists[type] || objects[key];

            var missing = !container;

            if (missing)
                container = {};

            var value = container;

            if (id !== null) {
                value = container[id];

                if (!value) {
                    value = container[id] = new Observable();
                    value.init(key, observer);
                }
            }

            if (missing || (container instanceof List && !localStorage['SyncStorage.List.' + type])) {
                setTimeout(function() {
                    var cached = localStorage['SyncStorage.List.' + type] || localStorage['SyncStorage.Object.' + key];

                    var update = parse(type, cached);

                    updateObject(container, update);

                    if (value instanceof List)
                        lists[key] = value;
                    else
                        objects[key] = value;

                    send({cmd: 'get', key: key});
                }, 0);
            }

            return value;
        };

        var updateObject = function(object, update) {
            if ((update instanceof Observable) && !(object instanceof Observable))
                Observable.mutate(object, update._key, observer);
            else if (update instanceof List && !(object instanceof List))
                List.mutate(object);

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

            var sjs = new SockJS(url);

            sjs.onopen = function() {
                console.log('connected to server');
                transport = sjs;

                var keys = requestedKeys.slice(0);

                Object.keys(sendQueue).sort().forEach(function(id) {
                    if (id !== 'id') {
                        var packet = sendQueue[id];
                        transport.send(packet);
                        var message = JSON.parse(packet), p;
                        if (message.cmd === 'get') {
                            p = keys.indexOf(message.key);
                            if (p !== -1)
                                keys.splice(p, 1); // resubscribing would be redundant
                        }
                    }
                });

                // resubscribe
                keys.forEach(function(key) {
                    transport.send(JSON.stringify({cmd: 'get', key: key}));
                });
            };

            sjs.onclose = function() {
                console.log('disconnected from server');
                transport = null;
                window.setTimeout(self.initTransport, 5000);
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

                var container = lists[type] || objects[key];

                if (id !== null) {
                    update = update[id];

                    if (container) {
                        if (update === null) {
                            delete container[id];
                        }
                        else {
                            if (container[id])
                                updateObject(container[id], update);
                            else
                                container[id] = update;
                        }
                    }
                }
                else {
                    if (update instanceof List) {
                        if (string !== null && string.length > 0 && string !== 'null')
                            localStorage['SyncStorage.List.' + type] = string;
                        else
                            delete localStorage['SyncStorage.List.' + type];
                    }
                    else {
                        if (string !== null && string.length > 0 && string !== 'null')
                            localStorage['SyncStorage.Object.' + key] = string;
                        else
                            delete localStorage['SyncStorage.Object.' + key];
                    }

                    if (!container)
                        container = objects[key] = {};

                    updateObject(container, update);
                }

                SyncStorage.angularTimeouts.forEach(function(timeout) {
                    timeout.trigger();
                });
            };

            sjs.onmessage = function(e) {
                if (typeof(e.data) == 'string') {
                    var string = e.data;
                    var p = 0, l = string.length;
                    while (p <= l && string.charAt(p++) != '\n');

                    var header = string.substring(0, p - 1);
                    var body = string.substring(p);

                    var parts = header.split(':');

                    var type = parts[0];

                    switch (type) {
                        case 'ack':
                            var id = parts[1];
                            if (sendQueue[id])
                                delete sendQueue[id];
                            break;
                        case 'data':
                            handleIncomingData(header, body);
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

    var getInstance = function() {
        var urls = Object.keys(instances);

        if (urls.length === 0)
            return window.SyncStorage.init();

        if (urls.length === 1)
            return instances[urls[0]];
    };

    window.SyncStorage = {
        angularTimeouts: [],

        init: function(url, preloadKeys) {
            if (!url)
                url = location.origin.replace(/:\d+$/, '')+':6580/sync-storage';

            if (!instances[url])
                instances[url] = new instance(url, preloadKeys);

            return instances[url];
        },

        get: function() {
            var instance = getInstance();
            return instance.get.apply(instance, arguments);
        },

        set: function() {
            var instance = getInstance();
            return instance.set.apply(instance, arguments);
        },

        'delete': function() {
            var instance = getInstance();
            return instance.delete.apply(instance, arguments);
        }
    };
})();
