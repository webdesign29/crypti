var Router = require('../helpers/router.js'),
	async = require('async'),
	request = require('request'),
	ip = require('ip'),
	util = require('util'),
	RequestSanitizer = require('../helpers/request-sanitizer.js'),
	normalize = require('../helpers/normalize.js');

//private fields
var modules, library, self;

var headers = {};
var loaded = false;

//constructor
function Transport(cb, scope) {
	library = scope;
	self = this;

	attachApi();

	setImmediate(cb, null, self);
}

//private methods
function attachApi() {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules && loaded) return next();
		res.status(500).send({success: false, error: 'loading'});
	});

	router.use(function (req, res, next) {
		var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

		if (peerIp == "127.0.0.1") {
			return next();
		}

		req.sanitize(req.headers, {
			port: "int",
			os: "string?",
			'share-port': {
				int: true,
				boolean: true
			},
			version: "string?"
		}, function (err, report, headers) {
			if (err) return next(err);
			if (!report.isValid) return {status: false, error: report.issues};


			var peer = {
				ip: ip.toLong(peerIp),
				port: headers.port,
				state: 2,
				os: headers.os,
				sharePort: Number(headers['share-port']),
				version: headers.version
			};


			if (peer.port > 0 && peer.port <= 65535 && peer.version == library.config.version) {
				modules.peer.update(peer);
			}

			next();
		});

	});

	router.get('/list', function (req, res) {
		res.set(headers);
		modules.peer.list(100, function (err, peers) {
			return res.status(200).json({peers: !err ? peers : []});
		})
	});

	router.get("/blocks/common", function (req, res, next) {
		res.set(headers);

		req.sanitize("query", {
			max: "int!",
			min: "int!",
			ids: {
				required: true,
				string: true,
				array: ",",
				minLength: 1,
				maxLength: 1000
			}
		}, function (err, report, query) {
			if (err) return next(err);
			if (!report.isValid) return res.json({success: false, error: report.issue});


			var max = query.max;
			var min = query.min;
			var ids = query.id.split(',').filter(function (id) {
				return /^\d+$/.test(id);
			});
			var escapedIds = ids.map(function (id) {
				return "'" + id + "'";
			});

			if (!escapedIds.length) {
				var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
				var peerStr = peerIp ? peerIp + ":" + RequestSanitizer.int(req.headers['port']) : 'unknown';
				library.logger.log('common block request is not valid, ban 60 min', peerStr);
				modules.peer.state(ip.toLong(peerIp), RequestSanitizer.int(req.headers['port']), 0, 3600);
				return res.json({success: false, error: "ids is invalid"});
			}

			library.dbLite.query("select max(height), id, previousBlock, timestamp, lower(hex(blockSignature)) from blocks where id in (" + escapedIds.join(',') + ") and height >= $min and height <= $max", {
				"max": max,
				"min": min
			}, {
				"height": Number,
				"id": String,
				"previousBlock": String,
				"timestamp": Number,
				"blockSignature": String
			}, function (err, rows) {
				if (err) {
					return res.json({success: false, error: "Error in db"});
				}

				var commonBlock = rows.length ? rows[0] : null;
				return res.json({success: true, common: commonBlock});
			});
		});
	});

	router.get("/blocks", function (req, res) {
		res.set(headers);

		var lastBlockId = RequestSanitizer.string(req.query.lastBlockId);

		// get 1400+ blocks with all data (joins) from provided block id
		modules.blocks.loadBlocksPart({limit: 1440, lastId: lastBlockId}, function (err, blocks) {
			return res.status(200).json({blocks: !err ? blocks : []});
		});
	});

	router.post("/blocks", function (req, res) {
		res.set(headers);

		try {
			var block = normalize.block(req.body.block)
		} catch (e) {
			var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
			var peerStr = peerIp ? peerIp + ":" + RequestSanitizer.int(req.headers['port']) : 'unknown';
			library.logger.log('transaction ' + (block ? block.id : 'null') + ' is not valid, ban 60 min', peerStr);
			modules.peer.state(ip.toLong(peerIp), RequestSanitizer.int(req.headers['port']), 0, 3600);
			return res.sendStatus(200);
		}

		library.bus.message('receiveBlock', block);

		res.sendStatus(200);
	});

	router.get("/transactions", function (req, res) {
		res.set(headers);
		// need to process headers from peer
		res.status(200).json({transactions: modules.transactions.getUnconfirmedTransactionList()});
	});

	router.post("/transactions", function (req, res) {
		res.set(headers);

		try {
			var transaction = library.logic.transaction.normalize(req.body.transaction);
		} catch (e) {
			var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
			var peerStr = peerIp ? peerIp + ":" + RequestSanitizer.int(req.headers['port']) : 'unknown';
			library.logger.log('transaction ' + (transaction ? transaction.id : 'null') + ' is not valid, ban 60 min', peerStr);
			modules.peer.state(ip.toLong(peerIp), RequestSanitizer.int(req.headers['port']), 0, 3600);
			return res.status(200).json({success: false, message: "Invalid transaction body"});
		}

		library.sequence.add(function (cb) {
			modules.transactions.receiveTransactions([transaction], cb);
		}, function (err) {
			if (err) {
				res.status(200).json({success: false, message: err});
			} else {
				res.status(200).json({success: true});
			}
		});
	});

	router.get('/height', function (req, res) {
		res.set(headers);
		res.status(200).json({
			height: modules.blocks.getLastBlock().height
		});
	});

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: 'api not found'});
	});

	library.app.use('/peer', router);

	library.app.use(function (err, req, res, next) {
		library.logger.error('/peer', err)
		if (!err) return next();
		res.status(500).send({success: false, error: err.toString()});
	});
}

function _request(peer, api, method, data, cb) {
	var req = {
		url: 'http://' + ip.fromLong(peer.ip) + ':' + peer.port + '/peer' + api,
		method: method,
		json: true,
		headers: headers,
		timeout: 5000
	};


	library.logger.trace('request', req.url);

	if (Object.prototype.toString.call(data) == "[object Object]" || util.isArray(data)) {
		req.json = data;
	} else {
		req.body = data;
	}

	request(req, function (err, response, body) {
		if (err || response.statusCode != 200) {
			library.logger.debug('request', {
				url: req.url,
				statusCode: response ? response.statusCode : 'unknown',
				err: err
			});

			if (peer) {
				if (err && (err.code == "ETIMEDOUT" || err.code == "ESOCKETTIMEDOUT" || err.code == "ECONNREFUSED")) {
					library.logger.info('remove peer ' + req.method + ' ' + req.url)
					modules.peer.remove(peer.ip, peer.port);
				} else {
					library.logger.info('ban 10 min ' + req.method + ' ' + req.url)
					modules.peer.state(peer.ip, peer.port, 0, 600);
				}
			}
			cb && cb(err || ('request status code' + response.statusCode));
			return;
		}

		var port = RequestSanitizer.int(response.headers['port']);
		if (port > 0 && port <= 65535 && RequestSanitizer.string(response.headers['version'], true) == library.config.version) {
			modules.peer.update({
				ip: peer.ip,
				port: port,
				state: 2,
				os: RequestSanitizer.string(response.headers['os'], true),
				sharePort: Number(!!RequestSanitizer.int(response.headers['share-port'])),
				version: RequestSanitizer.string(response.headers['version'], true)
			});
		}


		cb && cb(null, body);
	});
}

//public methods
Transport.prototype.broadcast = function (peersCount, method, data, cb) {
	peersCount = peersCount || 1;
	if (!cb && (typeof(data) == 'function')) {
		cb = data;
		data = undefined;
	}
	modules.peer.list(peersCount, function (err, peers) {
		if (!err) {
			async.eachLimit(peers, 3, function (peer, cb) {
				_request(peer, method, "POST", data);
				setImmediate(cb);
			}, function () {
				cb && cb(null, {body: null, peer: peers});
			})
		} else {
			cb && setImmediate(cb, err);
		}
	});
}

Transport.prototype.getFromRandomPeer = function (method, cb) {
	async.retry(20, function (cb) {
		modules.peer.list(1, function (err, peers) {
			if (!err && peers.length) {
				var peer = peers[0];
				_request(peer, method, "GET", undefined, function (err, body) {
					cb(err, {body: body, peer: peer});
				});
			} else {
				return cb(err || "Nothing peers in db");
			}
		});
	}, function (err, results) {
		cb(err, results)
	});
}

Transport.prototype.getFromPeer = function (peer, method, cb) {
	_request(peer, method, "GET", undefined, function (err, body) {
		cb(err, {body: body, peer: peer});
	});
}

//events
Transport.prototype.onBind = function (scope) {
	modules = scope;

	headers = {
		os: modules.system.getOS(),
		version: modules.system.getVersion(),
		port: modules.system.getPort(),
		'share-port': modules.system.getSharePort()
	}
}

Transport.prototype.onBlockchainReady = function () {
	loaded = true;
}

Transport.prototype.onUnconfirmedTransaction = function (transaction, broadcast) {
	broadcast && self.broadcast(100, '/transactions', {transaction: transaction});
}

Transport.prototype.onNewBlock = function (block, broadcast) {
	broadcast && self.broadcast(100, '/blocks', {block: block})
}

//export
module.exports = Transport;