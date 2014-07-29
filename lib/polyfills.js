// Object.keys polyfill from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/keys
if (!Object.keys) {
    Object.keys = (function() {
        'use strict';
        var hasOwnProperty = Object.prototype.hasOwnProperty,
            hasDontEnumBug = !({toString: null}).propertyIsEnumerable('toString'),
            dontEnums = [
                'toString',
                'toLocaleString',
                'valueOf',
                'hasOwnProperty',
                'isPrototypeOf',
                'propertyIsEnumerable',
                'constructor',
                '_key',
                '_id'
            ],
            dontEnumsLength = dontEnums.length;

        return function(obj) {
            if (typeof obj !== 'object' && (typeof obj !== 'function' || obj === null)) {
                throw new TypeError('Object.keys called on non-object');
            }

            var result = [], prop, i;

            for (prop in obj) {
                if (hasOwnProperty.call(obj, prop)) {
                    result.push(prop);
                }
            }

            if (hasDontEnumBug) {
                for (i = 0; i < dontEnumsLength; i++) {
                    if (hasOwnProperty.call(obj, dontEnums[i])) {
                        result.push(dontEnums[i]);
                    }
                }
            }
            return result;
        };
    }());
}


/*
 https://github.com/jdarling/Object.observe

 Tested against Chromium build with Object.observe and acts EXACTLY the same,
 though Chromium build is MUCH faster

 Trying to stay as close to the spec as possible,
 this is a work in progress, feel free to comment/update

 Specification:
 http://wiki.ecmascript.org/doku.php?id=harmony:observe

 Built using parts of:
 https://github.com/tvcutsem/harmony-reflect/blob/master/examples/observer.js

 Limits so far;
 Built using polling... Will update again with polling/getter&setters to make things better at some point

 TODO:
 Add support for Object.prototype.watch -> https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/watch
 */
"use strict";
if(false && !Object.observe){
    (function(extend, global){
        var isCallable = (function(toString){
            var s = toString.call(toString),
                u = typeof u;
            return typeof global.alert === "object" ?
                function(f){
                    return s === toString.call(f) || (!!f && typeof f.toString == u && typeof f.valueOf == u && /^\s*\bfunction\b/.test("" + f));
                }:
                function(f){
                    return s === toString.call(f);
                }
                ;
        })(extend.prototype.toString);
        // isNode & isElement from http://stackoverflow.com/questions/384286/javascript-isdom-how-do-you-check-if-a-javascript-object-is-a-dom-object
        //Returns true if it is a DOM node
        function isNode(o){
            return (
                    typeof Node === "object" ? o instanceof Node :
                o && typeof o === "object" && typeof o.nodeType === "number" && typeof o.nodeName==="string"
                );
        }
        //Returns true if it is a DOM element
        function isElement(o){
            return (
                    typeof HTMLElement === "object" ? o instanceof HTMLElement : //DOM2
                o && typeof o === "object" && o !== null && o.nodeType === 1 && typeof o.nodeName==="string"
                );
        }
        var _isImmediateSupported = (function(){
            return !!global.setImmediate;
        })();
        var _doCheckCallback = (function(){
            if(_isImmediateSupported){
                return function(f){
                    return setImmediate(f);
                };
            }else{
                return function(f){
                    return setTimeout(f, 10);
                };
            }
        })();
        var _clearCheckCallback = (function(){
            if(_isImmediateSupported){
                return function(id){
                    clearImmediate(id);
                };
            }else{
                return function(id){
                    clearTimeout(id);
                };
            }
        })();
        var isNumeric=function(n){
            return !isNaN(parseFloat(n)) && isFinite(n);
        };
        var sameValue = function(x, y){
            if(x===y){
                return x !== 0 || 1 / x === 1 / y;
            }
            return x !== x && y !== y;
        };
        var isAccessorDescriptor = function(desc){
            if (typeof(desc) === 'undefined'){
                return false;
            }
            return ('get' in desc || 'set' in desc);
        };
        var isDataDescriptor = function(desc){
            if (typeof(desc) === 'undefined'){
                return false;
            }
            return ('value' in desc || 'writable' in desc);
        };

        var validateArguments = function(O, callback, accept){
            if(typeof(O)!=='object'){
                // Throw Error
                throw new TypeError("Object.observeObject called on non-object");
            }
            if(isCallable(callback)===false){
                // Throw Error
                throw new TypeError("Object.observeObject: Expecting function");
            }
            if(Object.isFrozen(callback)===true){
                // Throw Error
                throw new TypeError("Object.observeObject: Expecting unfrozen function");
            }
            if (accept !== undefined) {
                if (!Array.isArray(accept)) {
                    throw new TypeError("Object.observeObject: Expecting acceptList in the form of an array");
                }
            }
        };

        var Observer = (function(){
            var wraped = [];
            var Observer = function(O, callback, accept){
                validateArguments(O, callback, accept);
                if (!accept) {
                    accept = ["add", "update", "delete", "reconfigure", "setPrototype", "preventExtensions"];
                }
                Object.getNotifier(O).addListener(callback, accept);
                if(wraped.indexOf(O)===-1){
                    wraped.push(O);
                }else{
                    Object.getNotifier(O)._checkPropertyListing();
                }
            };

            Observer.prototype.deliverChangeRecords = function(O){
                Object.getNotifier(O).deliverChangeRecords();
            };

            wraped.lastScanned = 0;
            var f = (function(wrapped){
                return function(){
                    var i = 0, l = wrapped.length, startTime = new Date(), takingTooLong=false;
                    for(i=wrapped.lastScanned; (i<l)&&(!takingTooLong); i++){
                        Object.getNotifier(wrapped[i])._checkPropertyListing();
                        takingTooLong=((new Date())-startTime)>100; // make sure we don't take more than 100 milliseconds to scan all objects
                    }
                    wrapped.lastScanned=i<l?i:0; // reset wrapped so we can make sure that we pick things back up
                    _doCheckCallback(f);
                };
            })(wraped);
            _doCheckCallback(f);
            return Observer;
        })();

        var Notifier = function(watching){
            var _listeners = [], _acceptLists = [], _updates = [], _updater = false, properties = [], values = [];
            var self = this;
            Object.defineProperty(self, '_watching', {
                enumerable: true,
                get: (function(watched){
                    return function(){
                        return watched;
                    };
                })(watching)
            });
            var wrapProperty = function(object, prop){
                var propType = typeof(object[prop]), descriptor = Object.getOwnPropertyDescriptor(object, prop);
                if((prop==='getNotifier')||isAccessorDescriptor(descriptor)||(!descriptor.enumerable)){
                    return false;
                }
                if((object instanceof Array)&&isNumeric(prop)){
                    var idx = properties.length;
                    properties[idx] = prop;
                    values[idx] = object[prop];
                    return true;
                }
                (function(idx, prop){
                    properties[idx] = prop;
                    values[idx] = object[prop];
                    Object.defineProperty(object, prop, {
                        get: function(){
                            return values[idx];
                        },
                        set: function(value){
                            if(!sameValue(values[idx], value)){
                                Object.getNotifier(object).queueUpdate(object, prop, 'update', values[idx]);
                                values[idx] = value;
                            }
                        }
                    });
                })(properties.length, prop);
                return true;
            };
            self._checkPropertyListing = function(dontQueueUpdates){
                var object = self._watching, keys = Object.keys(object), i=0, l=keys.length;
                var newKeys = [], oldKeys = properties.slice(0), updates = [];
                var prop, queueUpdates = !dontQueueUpdates, propType, value, idx, aLength;

                if(object instanceof Array){
                    aLength = object.length;
                }

                for(i=0; i<l; i++){
                    prop = keys[i];
                    value = object[prop];
                    propType = typeof(value);
                    if((idx = properties.indexOf(prop))===-1){
                        if(wrapProperty(object, prop)&&queueUpdates){
                            self.queueUpdate(object, prop, 'add', null, object[prop]);
                        }
                    }else{
                        if((object instanceof Array)&&(isNumeric(prop))){
                            if(values[idx] !== value){
                                if(queueUpdates){
                                    self.queueUpdate(object, prop, 'update', values[idx], value);
                                }
                                values[idx] = value;
                            }
                        }
                        oldKeys.splice(oldKeys.indexOf(prop), 1);
                    }
                }

                if(object instanceof Array && object.length !== aLength){
                    if(queueUpdates){
                        self.queueUpdate(object, 'length', 'update', aLength, object);
                    }
                }

                if(queueUpdates){
                    l = oldKeys.length;
                    for(i=0; i<l; i++){
                        idx = properties.indexOf(oldKeys[i]);
                        self.queueUpdate(object, oldKeys[i], 'delete', values[idx]);
                        properties.splice(idx,1);
                        values.splice(idx,1);
                    };
                }
            };
            self.addListener = function(callback, accept){
                var idx = _listeners.indexOf(callback);
                if(idx===-1){
                    _listeners.push(callback);
                    _acceptLists.push(accept);
                }
                else {
                    _acceptLists[idx] = accept;
                }
            };
            self.removeListener = function(callback){
                var idx = _listeners.indexOf(callback);
                if(idx>-1){
                    _listeners.splice(idx, 1);
                    _acceptLists.splice(idx, 1);
                }
            };
            self.listeners = function(){
                return _listeners;
            };
            self.queueUpdate = function(what, prop, type, was){
                this.queueUpdates([{
                    type: type,
                    object: what,
                    name: prop,
                    oldValue: was
                }]);
            };
            self.queueUpdates = function(updates){
                var self = this, i = 0, l = updates.length||0, update;
                for(i=0; i<l; i++){
                    update = updates[i];
                    _updates.push(update);
                }
                if(_updater){
                    _clearCheckCallback(_updater);
                }
                _updater = _doCheckCallback(function(){
                    _updater = false;
                    self.deliverChangeRecords();
                });
            };
            self.deliverChangeRecords = function(){
                var i = 0, l = _listeners.length,
                //keepRunning = true, removed as it seems the actual implementation doesn't do this
                // In response to BUG #5
                    retval;
                for(i=0; i<l; i++){
                    if(_listeners[i]){
                        var currentUpdates;
                        if (_acceptLists[i]) {
                            currentUpdates = [];
                            for (var j = 0, updatesLength = _updates.length; j < updatesLength; j++) {
                                if (_acceptLists[i].indexOf(_updates[j].type) !== -1) {
                                    currentUpdates.push(_updates[j]);
                                }
                            }
                        }
                        else {
                            currentUpdates = _updates;
                        }
                        if (currentUpdates.length) {
                            if(_listeners[i]===console.log){
                                console.log(currentUpdates);
                            }else{
                                _listeners[i](currentUpdates);
                            }
                        }
                    }
                }
                /*
                 for(i=0; i<l&&keepRunning; i++){
                 if(typeof(_listeners[i])==='function'){
                 if(_listeners[i]===console.log){
                 console.log(_updates);
                 }else{
                 retval = _listeners[i](_updates);
                 if(typeof(retval) === 'boolean'){
                 keepRunning = retval;
                 }
                 }
                 }
                 }
                 */
                _updates=[];
            };
            self.notify = function(changeRecord) {
                if (typeof changeRecord !== "object" || typeof changeRecord.type !== "string") {
                    throw new TypeError("Invalid changeRecord with non-string 'type' property");
                }
                changeRecord.object = watching;
                self.queueUpdates([changeRecord]);
            };
            self._checkPropertyListing(true);
        };

        var _notifiers=[], _indexes=[];
        extend.getNotifier = function(O){
            var idx = _indexes.indexOf(O), notifier = idx>-1?_notifiers[idx]:false;
            if(!notifier){
                idx = _indexes.length;
                _indexes[idx] = O;
                notifier = _notifiers[idx] = new Notifier(O);
            }
            return notifier;
        };
        extend.observe = function(O, callback, accept){
            // For Bug 4, can't observe DOM elements tested against canry implementation and matches
            if(!isElement(O)){
                return new Observer(O, callback, accept);
            }
        };
        extend.unobserve = function(O, callback){
            validateArguments(O, callback);
            var idx = _indexes.indexOf(O),
                notifier = idx>-1?_notifiers[idx]:false;
            if (!notifier){
                return;
            }
            notifier.removeListener(callback);
            if (notifier.listeners().length === 0){
                _indexes.splice(idx, 1);
                _notifiers.splice(idx, 1);
            }
        };
    })(Object, this);
}


// Production steps of ECMA-262, Edition 5, 15.4.4.18
// Reference: http://es5.github.com/#x15.4.4.18
if (!Array.prototype.forEach) {

    Array.prototype.forEach = function (callback, thisArg) {

        var T, k;

        if (this == null) {
            throw new TypeError(" this is null or not defined");
        }

        // 1. Let O be the result of calling ToObject passing the |this| value as the argument.
        var O = Object(this);

        // 2. Let lenValue be the result of calling the Get internal method of O with the argument "length".
        // 3. Let len be ToUint32(lenValue).
        var len = O.length >>> 0;

        // 4. If IsCallable(callback) is false, throw a TypeError exception.
        // See: http://es5.github.com/#x9.11
        if (typeof callback !== "function") {
            throw new TypeError(callback + " is not a function");
        }

        // 5. If thisArg was supplied, let T be thisArg; else let T be undefined.
        if (arguments.length > 1) {
            T = thisArg;
        }

        // 6. Let k be 0
        k = 0;

        // 7. Repeat, while k < len
        while (k < len) {

            var kValue;

            // a. Let Pk be ToString(k).
            //   This is implicit for LHS operands of the in operator
            // b. Let kPresent be the result of calling the HasProperty internal method of O with argument Pk.
            //   This step can be combined with c
            // c. If kPresent is true, then
            if (k in O) {

                // i. Let kValue be the result of calling the Get internal method of O with argument Pk.
                kValue = O[k];

                // ii. Call the Call internal method of callback with T as the this value and
                // argument list containing kValue, k, and O.
                callback.call(T, kValue, k, O);
            }
            // d. Increase k by 1.
            k++;
        }
        // 8. return undefined
    };
}


if (!Array.prototype.indexOf) {
    Array.prototype.indexOf = function (searchElement, fromIndex) {

        var k;

        // 1. Let O be the result of calling ToObject passing
        //    the this value as the argument.
        if (this == null) {
            throw new TypeError('"this" is null or not defined');
        }

        var O = Object(this);

        // 2. Let lenValue be the result of calling the Get
        //    internal method of O with the argument "length".
        // 3. Let len be ToUint32(lenValue).
        var len = O.length >>> 0;

        // 4. If len is 0, return -1.
        if (len === 0) {
            return -1;
        }

        // 5. If argument fromIndex was passed let n be
        //    ToInteger(fromIndex); else let n be 0.
        var n = +fromIndex || 0;

        if (Math.abs(n) === Infinity) {
            n = 0;
        }

        // 6. If n >= len, return -1.
        if (n >= len) {
            return -1;
        }

        // 7. If n >= 0, then Let k be n.
        // 8. Else, n<0, Let k be len - abs(n).
        //    If k is less than 0, then let k be 0.
        k = Math.max(n >= 0 ? n : len - Math.abs(n), 0);

        // 9. Repeat, while k < len
        while (k < len) {
            var kValue;
            // a. Let Pk be ToString(k).
            //   This is implicit for LHS operands of the in operator
            // b. Let kPresent be the result of calling the
            //    HasProperty internal method of O with argument Pk.
            //   This step can be combined with c
            // c. If kPresent is true, then
            //    i.  Let elementK be the result of calling the Get
            //        internal method of O with the argument ToString(k).
            //   ii.  Let same be the result of applying the
            //        Strict Equality Comparison Algorithm to
            //        searchElement and elementK.
            //  iii.  If same is true, return k.
            if (k in O && O[k] === searchElement) {
                return k;
            }
            k++;
        }
        return -1;
    };
}