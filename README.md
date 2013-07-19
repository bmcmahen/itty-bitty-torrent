node-bittorent
==============

A simple bittorrent client extracted from the awesome [peerflix](https://github.com/mafintosh/peerflix), built for Node.

## Install

	npm install itty-bitty-torrent

## Example

	var Torrent = require('itty-bitty-torrent');
	var downloadLocation = __dirname + '/download/';
	var torrent = __dirname + '/IAmALegalTorrent.torrent'; // or http URL

	var client = new Torrent(torrent, downloadLocation, function(err){
		if (!err) client.download();
		setInterval(function(){
			console.log(Math.round(client.speed()) / 1000);
		}, 500);
	});

	client.on('finished', function(){
		// The torrent has finished downloading.
	});

	// stop our torrent downloading & seeding
	client.stop();

## License

MIT