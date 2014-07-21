'use strict';

var http = require('http');
var fileSystem = require('fs');

var sockjs = require('sockjs');
var redis = require('redis');

var CombinedStream = require('combined-stream');

exports.CSV = require('./lib/sync-storage-csv.js').SyncStorageCsv;

exports.create = function(options) {
    var sjsServer = sockjs.createServer();

    sjsServer.on('connection', function(socket) {
        console.log('connection established with ' + socket.remoteAddress);

        var redisClient = redis.createClient();
        var subscriber = redis.createClient();

        var instance = {
            send: function(key, message) {
                socket.write(packet(key, message));

            },
            broadcast: function(key, message) {
                redisClient.publish(key, packet(key, message));
            },
            sendError: function(error) {
                instance.send('_error', null, JSON.stringify(error));
            }
        };

        var packet = function(key, message) {
            if (typeof(message) !== 'string')
                message = JSON.stringify(message);

            return 'data:' + key + '\n' + message;
        };

        subscriber.on('message', function(key, message) {
            socket.write(message);
        });

        socket.on('data', function(payload) {
            var data = JSON.parse(payload);

            if (data.cmd) {
                var response = null;

                if (data.key)
                    subscriber.subscribe(data.key);

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
                                instance.broadcast(data.key, value);
                            });
                            break;
                        case 'delete':
                            redisClient.del(data.key);
                            instance.broadcast(data.key, '');
                            break;
                        default:
                            console.log('unrecognized cmd: ', data.cmd);
                    }
                }
            }
            else
                console.log('unrecognized data: ', data);

            if (data.id !== null && typeof(data.id) !== 'undefined')
                socket.write('ack:' + data.id);
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
                var stream = CombinedStream.create();

                stream.append(fileSystem.createReadStream(__dirname + '/lib/sync-storage.js'));
                stream.append(fileSystem.createReadStream(__dirname + '/lib/sync-storage-csv.js'));
                stream.append(fileSystem.createReadStream(__dirname + '/lib/polyfills.js'));

                stream.pipe(response);
                break;
        }
    });

    sjsServer.installHandlers(server, {prefix: options.endoint || '/sync-storage'});

    server.listen(options.port || 6580, options.address || '0.0.0.0');
};
