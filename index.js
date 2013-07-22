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
  var self = this;
  this.readTorrent(function(err, torrent){
    if (err && fn) return fn(err);
    self.storage = new Storage(torrent, {
      path : path
    });
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
  dht.findPeers(peers);
  dht.on('peer', function(peer){
    self.swarm.add(peer);
  });
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

    var onchoketimeout = function(){
      return connection.emit('close');
    };

    wire.speed = speedometer();
    wire.on('unchoke', self.update.bind(self));
    wire.on('unchoke', function(){
      if (wire.timeout) clearTimeout(wire.timeout);
    });
    wire.on('choke', function(){
      if (wire.timeout) clearTimeout(wire.timeout);
      wire.timeout = setTimeout(onchoketimeout, 5000);
    });
    wire.on('have', self.update.bind(self));
    wire.once('interested', function(){ wire.unchoke(); });
    wire.setTimeout(PIECE_TIMEOUT, function(){ wire.destroy(); });
    wire.on('request', self.storage.read.bind(self.storage));
    wire.bitfield(self.have);
    wire.interested();
    wire.timeout = setTimeout(onchoketimeout, 5000);
  });

  swarm.on('download', function(bytes){
    self.speed(bytes);
  });

  this.findPeers();
};

Torrent.prototype.stop = function(){
  if (self.swarm) self.swarm.destroy();
  // xxx -> also delete our file?
  // have pause / destroy disambiguity?
};

Torrent.prototype.update = function(){
  var self = this;
  // This could be much more efficient. Basically, every time
  // we get information from a wire that it has something, or it has
  // unchoked us, we loop through _all_ of our wires and request
  // information for each. It would make more sense to just request
  // for each wire when it is unchoked or 'have', and then when
  // a piece is finished, we make another request from that peer.
  this.swarm.wires.forEach(function(peer){
    if (peer.peerChoking) return;
    self.select(peer);
    if (!peer.requests && self.storage.missing.length < 30)
      self.select(peer, true);
  });
};

// Request the pieces that we are missing. Missing pieces
// are stored in Storage.
Torrent.prototype.select = function(peer, force){
  var storage = this.storage;
  var requesting = this.requesting;
  var peerOffset = this.calculateOffset(peer);

  storage.missing
    .slice(peerOffset)
    .some(function(piece){

      if (peer.requests >= MAX_QUEUED) return true;

      // Make sure that our peer actually has the piece
      // before requesting it.
      if (!peer.peerPieces[piece]) return;
      var offset = storage.select(piece, force);
      if (offset === -1) return;

      requesting[piece] = requesting[piece] || [];
      requesting[piece].push(peer);

      peer.request(piece, offset, storage.sizeof(piece, offset), function(err, buffer){
        remove(requesting[piece], peer);
        if (err) return storage.deselect(piece, offset);
        storage.write(piece, offset, buffer);
      });
    });
};

Torrent.prototype.calculateOffset = function(me){
  var speed = me.speed();
  var time = MAX_QUEUED * BLOCK_SIZE / (speed || 1);
  var max = this.storage.missing.length > 60
    ? this.storage.missing.length - 30
    : this.storage.missing.length - 1;
  var data = 0;
  var self = this;

  this.swarm.wires.forEach(function(wire){
    if (!wire.peerPieces[self.storage.missing[0]]) return;
    if (wire.peerChoking) return;
    if (me === wire || wire.speed() < speed) return;
    data += wire.speed() * time;
  });

  return Math.min(Math.floor(data / this.torrent.pieceLength), max);
};

// Return percentage downloaded.
Torrent.prototype.percentage = function(){
  if (!this.storage) return;
  return this.storage.percentageDownloaded();
};

