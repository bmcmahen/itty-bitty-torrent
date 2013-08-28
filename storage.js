// storage

var partFile = require('part-file');
var piece = require('./piece');
var fs = require('fs');
var events = require('events');
var util  = require('util');
var nodePath = require('path');

/**
 * Constructor: Each file contained within the Torrent
 * @param {Object} file
 * @param {Object} torrent
 * @param {String} path
 */

function File(file, torrent, path){
  if (!(this instanceof File)) return new File(file, torrent, path);
  events.EventEmitter.call(this);
  this.torrent = torrent;
  this.path = nodePath.join(path, file.name);
  this.name = file.name;
  this.length = file.length;
  this.offset = file.offset;
  this.getPosition().tryToResume();
};

util.inherits(File, events.EventEmitter);

/**
 * Determine our Position within Torrent PieceLength
 * and create our destination file.
 * @return {File}
 */

File.prototype.getPosition = function(){
  this.start = this.offset / this.torrent.pieceLength | 0;
  this.end = ((this.offset + this.length + 1) / this.torrent.pieceLength) | 0;
  var sliced = this.torrent.pieces.slice(this.start, this.end + 1);
  this.destination = partFile(this.path, this.torrent.pieceLength, sliced);
  this.destination.on('readable', this.onReadable.bind(this));
  return this;
};

/**
 * Let our Storage know when a part becomes readable
 * so that it can be shared with peers.
 * @param  {Number} i
 */

File.prototype.onReadable = function(i){
  i += this.start;
  this.emit('partReadable', i);
};

/**
 * Check to see if we should resume our download.
 */

File.prototype.tryToResume = function(){
  var self = this;
  fs.exists(this.path, function(exists){
    if (!exists) return;
    var i = self.start;
    var verifyNext = function(){
      self.destination.verify(i, function(){
        if (++i <= self.end) verifyNext();
      });
    };
    verifyNext();
  });
};


/**
 * Constructor - Wrapper for Files & keeps track of
 * our pieces and missing pieces.
 * @param {Object} torrent
 * @param {Object} options
 */

function Storage(torrent, options){
  if (!(this instanceof Storage)) return new Storage(torrent, options);
  events.EventEmitter.call(this);
  this.torrent = torrent;
  this.options = options || {};
  this.path = options.path;
  this.missing = [];

  var self = this;
  this.files = this.torrent.files.map(function(file){
    var f = new File(file, torrent, options.path, self);
    f.on('partReadable', self.onPartReadable.bind(self));
    return f;
  });

  this.getPieces();
};

module.exports = Storage;

util.inherits(Storage, events.EventEmitter);

Storage.prototype.getPieces = function(){
  var self = this;
  var torrent = this.torrent;
  var lastFile = torrent.files[torrent.files.length - 1];

  this.pieces = torrent.pieces.map(function(_, i){
    self.missing.push(i);
    if (i === torrent.pieces.length - 1)
      return piece(((lastFile.length + lastFile.offset) % torrent.pieceLength || torrent.pieceLength));
    return piece(torrent.pieceLength);
  });
};

// A (loose) estimate of percentage downloaded, number of missing
// pieces remaining. This could be more accurate.

Storage.prototype.percentageDownloaded = function(){
  var len = this.pieces.length;
  var remaining = len - this.missing.length;
  return (remaining / len) * 100;
};

Storage.prototype.onPartReadable = function(index){
  var i = this.missing.indexOf(index);
  this.pieces[index] = null;
  if (i > -1) this.missing.splice(i, 1);
  this.emit('readable', index);
  if (index === 0) this.emit('buffered');
  if (this.pieces.every(function(piece){ return !piece })){
    this.emit('finished');
  }
};

Storage.prototype.sizeof = function(index, offset){
  var p = this.pieces[index];
  return p ? p.sizeof(offset) : 0;
};

Storage.prototype.select = function(index, force){
  var p = this.pieces[index];
  if (!p) return -1;
  var i = p.select();
  return i === -1 && force ? p.select(true) : i;
};

Storage.prototype.deselect = function(index, offset){
  var p = this.pieces[index];
  if (p) p.deselect(offset);
};

Storage.prototype.findDestination = function(i){
  var destinationFile;
  this.files.some(function(file){
    if (i >= file.start && i <= file.end) {
      destinationFile = file;
      return true;
    }
  });
  return destinationFile;
}

Storage.prototype.write = function(index, offset, block){
  var p = this.pieces[index];

  if (!p) return;
  var buffer = p.write(offset, block);
  if (!buffer) return;
  var file = this.findDestination(index);
  file.destination.write(index - file.start, buffer, function(err){
    if (err) return p.reset();
  });
};

Storage.prototype.read = function(i, offset, l, fn){
  var file = this.findDestination(i);
  file.destination.read(i - file.start, function(err, buffer){
    if (err) return fn(err);
    fn(null, buffer.slice(offset, offset + l));
  });
};

