'use strict';

var http = require('http');
var fs = require('fs');

var sockjs = require('sockjs');
var redis = require('redis');

exports.CSV = require('./lib/sync-storage-csv.js').SyncStorageCsv;

function streamConcat(file, output, callback) {
    var input = fs.createReadStream(file);

    if (typeof(callback) === 'function') {
        input.on('end', callback);
        input.pipe(output, {end: false});
    }
    else
        input.pipe(output);
}

exports.create = function(options) {
    var sjsServer = sockjs.createServer(options.sockjsOptions);

    sjsServer.on('connection', function(socket) {
        console.log('connection established with ' + socket.remoteAddress);

        var redisClient = redis.createClient();
        var subscriber = redis.createClient();

        var instance = {
            socket: socket,
            subscriber: subscriber,
            publisher: redisClient,
            broadcastPrefix: '',
            send: function(data, message, type) {
                socket.write(packet(data, message, type));
            },
            broadcast: function(data, message, type) {
                instance.send(data, message, type);

                var key = data.key || data;

                var target = key;

                do {
                    var channel = instance.broadcastPrefix + target;

                    redisClient.publish(channel, packet(key, message, type));

                    if (target.indexOf(':') === -1)
                        break;

                    target = target.replace(/:[^:]*$/, '');
                } while (true);
            },
            sendError: function(error, data) {
                var packetId = data && data.id ? ('@'+data.id) : '';
                socket.write('error'+packetId+'\n' + JSON.stringify(error));
            }
        };

        var packet = function(data, message, type) {
            if (typeof(message) !== 'string')
                message = JSON.stringify(message);

            var id = data.key || data;

            if (data.id)
                id += '@'+data.id;

            if (typeof(type) !== 'string')
                type = type ? 'r' : 'rw';

            return type + ':' + id + '\n' + message;
        };

        var subscriptions = {};

        subscriber.on('pmessage', function(pattern, channel, message) {
            if (channel.length < instance.broadcastPrefix.length)
                return;

            var key = channel.substring(instance.broadcastPrefix.length);

            if (subscriptions[key] || subscriptions[key.replace(/:.*/, '')])
                socket.write(message);
        });

        var subscribed = false;

        socket.on('data', function(payload) {
            var data = JSON.parse(payload);

            if (data.cmd) {
                if (data.key) {
                    var parts = data.key.match(/([^:]*)(?:[:](.*))?/);
                    var type = parts[1];

                    // if we're already subscribed to everything for the type we can skip the rest of this
                    if (!subscriptions[type]) {
                        var ids = (parts[2] || '').split(',');

                        ids.forEach(function (id) {
                            var key = type + (id ? ':' + id : '');
                            subscriptions[key] = true;
                        });
                    }

                    if (!subscribed && instance.broadcastPrefix) {
                        var channel = instance.broadcastPrefix;
                        subscriber.psubscribe(channel + '*');
                        // can't find a way to list pattern subscriptions so we'll subscribe to the channel too
                        subscriber.subscribe(channel);
                        subscribed = true;
                    }
                }

                // check for a command override
                if (!options[data.cmd] || !options[data.cmd](instance, data)) {
                    switch (data.cmd) {
                        case 'get':
                            redisClient.get(data.key, function(error, value) {
                                if (error)
                                    instance.sendError(error);
                                else
                                    instance.send(data.key, value);
                            });
                            break;
                        case 'set':
                            var value = data.value;
                            if (typeof(value) !== 'string')
                                value = JSON.stringify(value);

                            redisClient.get(data.key, function(error, oldValue) {
                                // only broadcast if it really changed
                                if (oldValue && oldValue === value)
                                    return;

                                redisClient.set(data.key, value);
                                instance.broadcast(instance.broadcastPrefix + data.key, value);
                            });
                            break;
                        case 'delete':
                            redisClient.del(data.key);
                            instance.broadcast(instance.broadcastPrefix + data.key, '');
                            break;
                        default:
                            console.log('unrecognized cmd: ', data.cmd);
                    }
                }
            }
            else
                console.log('unrecognized data: ', data);

            if (data.id !== null && typeof(data.id) !== 'undefined')
                socket.write('ack@' + data.id);
        });

        socket.on('close', function() {
            console.log('connection closed');
            redisClient.quit();
            subscriber.quit();
        });
    });

    var server = http.createServer(function(request, response) {
        var path = request.url.substring(1);

        switch (path) {
            case 'sync-storage.js':
                response.setHeader('content-type', 'text/javascript');

                streamConcat(__dirname + '/lib/sync-storage.js', response, function() {
                    streamConcat(__dirname + '/lib/sync-storage-csv.js', response, function() {
                        streamConcat(__dirname + '/lib/polyfills.js', response); }); });

                break;
            default:
                if (typeof(options.httpHandler) === 'function') {
                    if (options.httpHandler(request, response))
                        return;
                }
                break;
        }
    });

    sjsServer.installHandlers(server, {prefix: options.endoint || '/sync-storage'});

    server.listen(options.port || 8081, options.address || '0.0.0.0');

    return {
        server: server,
        sockJsServer: sjsServer,
        options: options
    }
};
