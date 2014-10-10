#!/usr/bin/env node
'use strict';

//Set jshint to ignore `predef:'io'` in .jshintrc so we can manually define io here
/* global -io */

var config      = require('./config')(process.argv.length > 2 ? JSON.parse(process.argv[2]) : {});

console.log("Config set to %j", config);

var Rx          = require('rx'),
    _           = require('underscore'),
    debug       = require('debug')('StreamGL:server'),
    fs          = require('fs');

var driver      = require('./js/node-driver.js'),
    compress    = require(config.NODE_CL_PATH + '/compress/compress.js'),
    renderer    = require(config.STREAMGL_PATH + 'renderer.js');

var express = require('express'),
    app = express(),
    http = require('http').Server(app),
    io = require('socket.io')(http, {transports: ['websocket']});

//FIXME CHEAP HACK TO WORK AROUND CONFIG FILE INCLUDE PATH
var cwd = process.cwd();
process.chdir(config.GPU_STREAMING_PATH + 'StreamGL');
var renderConfig = require(config.STREAMGL_PATH + 'renderer.config.graph.js');
process.chdir(cwd);


/**** GLOBALS ****************************************************/

// ----- BUFFERS (multiplexed over clients) ----------
//Serve most recent compressed binary buffers
//TODO reuse across users
//{socketID -> {buffer...}
var lastCompressedVbos;
var finishBufferTransfers;


// ----- ANIMATION ------------------------------------
//current animation
var animStep;

//multicast of current animation's ticks
var ticksMulti;

//most recent tick
var graph;


// ----- INITIALIZATION ------------------------------------

//Do more innocuous initialization inline (famous last words..)

function resetState () {
    debug('RESETTING APP STATE');

    //FIXME explicitly destroy last graph if it exists?

    lastCompressedVbos = {};
    finishBufferTransfers = {};


    animStep = driver.create();
    ticksMulti = animStep.ticks.publish();
    ticksMulti.connect();

    //make available to all clients
    graph = new Rx.ReplaySubject(1);
    ticksMulti.take(1).subscribe(graph);


    debug('RESET APP STATE.');
}


resetState();


/**** END GLOBALS ****************************************************/



/** Given an Object with buffers as values, returns the sum size in megabytes of all buffers */
function vboSizeMB(vbos) {
    var vboSizeBytes = _.reduce(_.values(vbos.buffers), function(sum, v) {
            return sum + v.byteLength;
        }, 0);
    return Math.round((Math.round(vboSizeBytes / 1024) / 1024) * 100) / 100;
}


// Express middleware function for sending "don't cache" headers to the browser
function nocache(req, res, next) {
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.header('Expires', '-1');
    res.header('Pragma', 'no-cache');
    next();
}
app.use(nocache);



app.get('/vbo', function(req, res) {
    debug('VBOs: HTTP GET %s', req.originalUrl, req.query);

    try {
        // TODO: check that query parameters are present, and that given id, buffer exist
        var bufferName = req.query.buffer;
        var id = req.query.id;

        res.set('Content-Encoding', 'gzip');

        res.send(lastCompressedVbos[id][bufferName]);
    } catch (e) {
        console.error('bad request', e, e.stack);
    }

    finishBufferTransfers[id](bufferName);
});

var colorTexture = new Rx.ReplaySubject(1);
var img =
    Rx.Observable.fromNodeCallback(fs.readFile)('test-colormap2.rgba')
    .flatMap(function (buffer) {
        debug('Loaded raw colorTexture', buffer.length);
        return Rx.Observable.fromNodeCallback(compress.deflate)(
                buffer,//binary,
                {output: new Buffer(
                    Math.max(1024, Math.round(buffer.length * 1.5)))})
            .map(function (compressed) {
                return {
                    raw: buffer,
                    compressed: compressed
                };
            });
    })
    .do(function () { debug('Compressed color texture'); })
    .map(function (pair) {
        debug('colorMap bytes', pair.raw.length);
        return {
            buffer: pair.compressed[0],
            bytes: pair.raw.length,
            width: 512,
            height: 512
        };
    });

img.take(1).subscribe(colorTexture);
colorTexture.subscribe(function() { debug('HAS COLOR TEXTURE'); }, function (err) { debug('oops', err, err.stack); });



app.get('/vbo', function(req, res) {
    debug('VBOs: HTTP GET %s', req.originalUrl);

    try {
        // TODO: check that query parameters are present, and that given id, buffer exist
        var bufferName = req.query.buffer;
        var id = req.query.id;

        res.set('Content-Encoding', 'gzip');
        res.send(lastCompressedVbos[id][bufferName]);

    } catch (e) {
        console.error('bad request', e, e.stack);
    }

    finishBufferTransfers[id](bufferName);
});

app.get('/texture', function (req, res) {
    debug('got texture req', req.originalUrl, req.query);
    try {

        var textureName = req.query.texture;
        var id = req.query.id;

        colorTexture.pluck('buffer').subscribe(function (data) {
            res.set('Content-Encoding', 'gzip');
            res.send(data);
        });

    } catch (e) {
        console.error('bad request', e, e.stack);
    }
});



io.on('connection', function(socket) {
    debug('Client connected', socket.id);

    // ========== BASIC COMMANDS

    lastCompressedVbos[socket.id] = {};
    socket.on('disconnect', function () {
        debug('disconnecting', socket.id);
        delete lastCompressedVbos[socket.id];
    });

    var activeBuffers = renderer.getServerBufferNames(renderConfig);
    var activeTextures = renderer.getServerTextureNames(renderConfig);
    var activePrograms = renderConfig.scene.render;

    debug('active buffers/textures/programs', activeBuffers, activeTextures, activePrograms);

    socket.on('graph_settings', function (payload) {
        debug('new settings', payload, socket.id);
        animStep.proxy(payload);
    });

    socket.on('reset_graph', function (_, cb) {
        debug('reset_graph command');
        resetState();
        cb();
    });


    // ============= EVENT LOOP

    //starts true, set to false whenever transfer starts, true again when ack'd
    var clientReady = new Rx.ReplaySubject(1);
    clientReady.onNext(true);
    socket.on('received_buffers', function (time) {
        debug('Client end-to-end time', time);
        clientReady.onNext(true);
    });

    clientReady.subscribe(debug.bind('CLIENT STATUS'));

    debug('SETTING UP CLIENT EVENT LOOP');
    graph.expand(function (graph) {

        debug('1. Prefetch VBOs', socket.id);

        return driver.fetchData(graph, compress, activeBuffers, activePrograms)
            .do(function (vbos) {
                debug('prefetched VBOs for xhr2: ' + vboSizeMB(vbos.compressed) + 'MB');
                //tell XHR2 sender about it
                lastCompressedVbos[socket.id] = vbos.compressed;
            })
            .flatMap(function (vbos) {
                debug('2. Waiting for client to finish previous', socket.id);
                return clientReady
                    .filter(_.identity)
                    .take(1)
                    .do(function () {
                        debug('2b. Client ready, proceed and mark as processing.', socket.id);
                        clientReady.onNext(false);
                    })
                    .map(_.constant(vbos));
            })
            .flatMap(function (vbos) {
                debug('3. tell client about availablity', socket.id);

                //for each buffer transfer
                var sendingAllBuffers = new Rx.Subject();
                var clientAckStartTime;
                var clientElapsed;
                var transferredBuffers = [];
                finishBufferTransfers[socket.id] = function (bufferName) {
                    debug('3a ?. sending a buffer', bufferName, socket.id);
                    transferredBuffers.push(bufferName);
                    if (transferredBuffers.length === activeBuffers.length) {
                        debug('3b. started sending all', socket.id);
                        debug('Socket', '...client ping ' + clientElapsed + 'ms');
                        debug('Socket', '...client asked for all buffers',
                            Date.now() - clientAckStartTime, 'ms');
                        sendingAllBuffers.onNext();
                    }
                };

                var emitFnWrapper = Rx.Observable.fromCallback(socket.emit, socket);

                //notify of buffer/texture metadata
                //FIXME make more generic and account in buffer notification status
                colorTexture.flatMap(function (colorTexture) {
                        debug('========got texture meta');
                        var lengths =
                            _.pick(
                                _.extend(
                                    vbos,
                                    {textures:
                                        {colorMap: _.pick(colorTexture, ['width', 'height', 'bytes']) }}),
                                ['bufferByteLengths', 'textures', 'elements']);

                        debug('notifying client of byte lengths', lengths);
                        return emitFnWrapper('vbo_update', lengths);
                    }).subscribe(function (clientElapsedMsg) {
                        debug('3d ?. client all received', socket.id);
                        clientElapsed = clientElapsedMsg;
                        clientAckStartTime = Date.now();
                    });

                return sendingAllBuffers
                    .take(1)
                    .do(debug.bind('3c. All in transit', socket.id));
            })
            .flatMap(function () {
                debug('4. Wait for next anim step', socket.id);
                return ticksMulti
                    .take(1)
                    .do(function () { debug('4b. next ready!', socket.id); });
            })
            .map(_.constant(graph));
    })
    .subscribe(function () { debug('LOOP ITERATED', socket.id); });

});


app.use(express.static(config.GPU_STREAMING_PATH));

http.listen(config.LISTEN_PORT, config.LISTEN_ADDRESS, function() {
    console.log('\nServer listening on %s:%d', config.LISTEN_ADDRESS, config.LISTEN_PORT);
});
