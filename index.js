var Swarm = require('peer-wire-swarm');
var readTorrent = require('read-torrent');
var hat = require('hat');
var speedometer = require('speedometer');
var bitfield = require('bitfield');
var DHT = require('bittorrent-dht');
var Storage = require('./storage');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var remove = function(arr, item) {
  if (!arr) return false;
  var i = arr.indexOf(item);
  if (i === -1) return false;
  arr.splice(i, 1);
  return true;
};

// Constants
var BLOCK_SIZE = 16*1024;
var MAX_PEERS = 30;
var MIN_PEERS = 0;
var MAX_QUEUED = 5;
var MIN_SPEED = 5 * 1024;
var CHOKE_TIMEOUT = 5000;
var PIECE_TIMEOUT = 30000;

function Torrent(file, path, fn){
  if (!(this instanceof Torrent)) return new Torrent(file, path, fn);
  EventEmitter.call(this);
  this.file = file;
  this.peerId = '-TD0005-'+hat(48);
  this.requesting = [];
  this.speed = speedometer();
  this.buffered = false;
  var self = this;
  this.readTorrent(function(err, torrent){
    if (err && fn) return fn(err);
    self.storage = new Storage(torrent, { path : path });
    self.storage.on('finished', function(){
      self.emit('finished');
    });
    self.storage.on('readable', self.onStorageReadable.bind(self));
    if (fn) fn();
  });
};

util.inherits(Torrent, EventEmitter);

module.exports = Torrent;

Torrent.prototype.onStorageReadable = function(i){
  delete this.requesting[i];
  this.have.set(i);
  if (!this.buffered) {
    this.emit('buffered');
    this.buffered = true;
  }
  this.swarm.wires.forEach(function(wire){
    wire.have(i);
  });
};

Torrent.prototype.readTorrent = function(fn){
  var self = this;
  readTorrent(this.file, function(err, torrent){
    if (err) return fn(err);
    self.torrent = torrent;
    self.have = bitfield(torrent.pieces.length);
    return fn(null, torrent);
  });
};


/**
 * Use DHT protocol to find peers. Default is to find 300 peers,
 * although these are added to a queue.
 * @param  {Number} num
 * @return {Torrent}
 */

Torrent.prototype.findPeers = function(num){
  var self = this;
  var dht = new DHT(new Buffer(this.torrent.infoHash, 'hex'));
  var peers = num || 300;
  console.log('find peers!');
  dht.on('peer', function(peer){
    console.log('peer', peer);
    self.swarm.add(peer);
  });
  dht.findPeers(peers);
  return this;
};

// All connections start off as 'not interested' and 'choked'
// In order to get to the state where you can receive files, you
// need to send your peer an 'Interested' message, and they need
// to send you an Unchoke message. You should wait for this unchoke message
// from your peer before requesting pieces. Once you are unchoked
// a client can still sned you a Choke message at any time, at which point you
// should refrain from requestin pieces from that peer.

Torrent.prototype.swarm = Torrent.prototype.download = function(){
  var swarm = this.swarm = Swarm(this.torrent.infoHash, this.peerId);
  var self = this;

  swarm.on('wire', function(wire, connection){
      var requesting = self.requesting;
      var storage = self.storage;

    // note: this no longer front loads everything, making it
    // a poor choice for streaming torrent videos. Also, our
    // progress indicator isn't really accurate anymore either. The
    // download progress will be slow to start, and fast to end.

    var getPieces = function(){
      wire.peerPieces.some(function(piece, i){

        if (!piece || !storage.pieces[i]) return;
        if (wire.requests.length >= MAX_QUEUED) {
          return true;
        }

        var offset = storage.select(i);
        if (offset === -1) return;

        console.log('requesting', i);
        wire.request(i, offset, storage.sizeof(i, offset), function(err, buf){
          if (err) return storage.deselect(i, offset);
          storage.write(i, offset, buf);
          getPieces();
        });
      });
    }


    wire.on('have', function(i){
      if (!storage.missing[i]) return;
      if (wire.requests.length >= MAX_QUEUED) return;
      var offset = storage.select(i);
      if (offset === -1) return;
      wire.request(i, offset, storage.sizeof(i, offset), function(err, buf){
        if (err) return storage.deselect(i, offset);
        storage.write(i, offset, buf);
        getPieces();
      });
    });


    wire.speed = speedometer();
    wire.on('unchoke', getPieces);
    wire.once('interested', function(){ wire.unchoke(); });
    wire.setTimeout(PIECE_TIMEOUT, function(){ wire.destroy(); });
    wire.on('request', self.storage.read.bind(self.storage));
    wire.bitfield(self.have);
    wire.interested();
  });

  swarm.on('download', function(bytes){
    self.speed(bytes);
  });

  this.findPeers();
};

Torrent.prototype.stop = function(){
  if (this.swarm) this.swarm.destroy();
};

// Return percentage downloaded.
Torrent.prototype.percentage = function(){
  if (!this.storage) return;
  return this.storage.percentageDownloaded();
};

