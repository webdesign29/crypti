var ed = require('ed25519'),
	util = require('util'),
	ByteBuffer = require("bytebuffer"),
	crypto = require('crypto'),
	genesisblock = null,
	constants = require("../helpers/constants.js"),
	slots = require('../helpers/slots.js'),
	extend = require('extend'),
	Router = require('../helpers/router.js'),
	async = require('async'),
	RequestSanitizer = require('../helpers/request-sanitizer.js'),
	TransactionTypes = require('../helpers/transaction-types.js'),
	Diff = require('../helpers/diff.js'),
	errorCode = require('../helpers/errorCodes.js').error,
	sandboxHelper = require('../helpers/sandbox.js');

// private fields
var modules, library, self, private = {}, shared = {};
private.unconfirmedSignatures = {};

function Multisignature() {
	this.create = function (data, trs) {
		trs.recipientId = null;
		trs.amount = 0;
		trs.asset.multisignature = {
			min: data.min,
			keysgroup: data.keysgroup,
			lifetime: data.lifetime
		};

		return trs;
	}

	this.calculateFee = function (trs, sender) {
		return ((trs.asset.multisignature.keysgroup.length + 1) * 5) * constants.fixedPoint;
	}

	this.verify = function (trs, sender, cb) {
		if (!trs.asset.multisignature) {
			return setImmediate(cb, "Invalid asset: " + trs.id);
		}

		if (!util.isArray(trs.asset.multisignature.keysgroup)) {
			return setImmediate(cb, "Wrong transaction asset for multisignature transaction: " + trs.id);
		}

		if (trs.asset.multisignature.keysgroup.length == 0) {
			return setImmediate(cb, "Multisignature can't contain less then one member");
		}

		if (trs.asset.multisignature.min <= 1 || trs.asset.multisignature.min > 16) {
			return setImmediate(cb, "Wrong transaction asset min for multisignature transaction: " + trs.id);
		}

		if (trs.asset.multisignature.min > trs.asset.multisignature.keysgroup.length + 1) {
			return setImmediate(cb, "Wrong multisignature min");
		}

		if (trs.asset.multisignature.lifetime < 1 || trs.asset.multisignature.lifetime > 72) {
			return setImmediate(cb, "Wrong transaction asset lifetime for multisignature transaction: " + trs.id);
		}

		// if it's ready
		if (this.ready(trs, sender)) {
			try {
				for (var s = 0; s < trs.asset.multisignature.keysgroup.length; s++) {
					var verify = false;
					if (trs.signatures) {
						for (var d = 0; d < trs.signatures.length && !verify; d++) {
							if (trs.asset.multisignature.keysgroup[s][0] != '-' && trs.asset.multisignature.keysgroup[s][0] != '+') {
								verify = false;
							} else {
								verify = library.logic.transaction.verifySignature(trs, trs.asset.multisignature.keysgroup[s].substring(1), trs.signatures[d]);
							}
						}
					}

					if (!verify) {
						return setImmediate(cb, "Failed multisignature verification: " + trs.id);
					}
				}
			} catch (e) {
				return setImmediate(cb, "Failed multisignature exception: " + trs.id);
			}
		}

		if (trs.asset.multisignature.keysgroup.indexOf("+" + sender.publicKey) != -1) {
			return setImmediate(cb, errorCode("MULTISIGNATURES.SELF_SIGN"));
		}

		async.eachSeries(trs.asset.multisignature.keysgroup, function (key, cb) {
			var math = key[0];
			var publicKey = key.slice(1);

			if (math != '+') {
				return cb("Math wrong");
			}

			// check that there is publicKey
			try {
				var b = new Buffer(publicKey, 'hex');
				if (b.length != 32) {
					return cb("Wrong public key" + publicKey);
				}
			} catch (e) {
				return cb("Wrong public key: " + publicKey);
			}

			return setImmediate(cb);
		}, function (err) {
			if (err) {
				return cb(err);
			}

			var keysgroup = trs.asset.multisignature.keysgroup.reduce(function (p, c) {
				if (p.indexOf(c) < 0) p.push(c);
				return p;
			}, []);

			if (keysgroup.length != trs.asset.multisignature.keysgroup.length) {
				return setImmediate(cb, errorCode("MULTISIGNATURES.NOT_UNIQUE_SET"));
			}

			setImmediate(cb, null, trs);
		});
	}

	this.process = function (trs, sender, cb) {
		setImmediate(cb, null, trs);
	}

	this.getBytes = function (trs, skip) {
		var keysgroupBuffer = new Buffer(trs.asset.multisignature.keysgroup.join(''), 'utf8');

		var bb = new ByteBuffer(1 + 1 + keysgroupBuffer.length, true);
		bb.writeByte(trs.asset.multisignature.min);
		bb.writeByte(trs.asset.multisignature.lifetime);
		for (var i = 0; i < keysgroupBuffer.length; i++) {
			bb.writeByte(keysgroupBuffer[i]);
		}
		bb.flip();

		return bb.toBuffer();
	}

	this.apply = function (trs, sender, cb) {
		private.unconfirmedSignatures[sender.address] = false;

		this.scope.account.merge(sender.address, {
			multisignatures: trs.asset.multisignature.keysgroup,
			multimin: trs.asset.multisignature.min,
			multilifetime: trs.asset.multisignature.lifetime
		}, function (err) {
			if (err) {
				return cb(err);
			}

			// get public keys
			async.eachSeries(trs.asset.multisignature.keysgroup, function (item, cb) {
				var key = item.substring(1);
				var address = modules.accounts.generateAddressByPublicKey(key);

				// create accounts
				modules.accounts.setAccountAndGet({
					address: address,
					publicKey: key
				}, function (err) {
					cb(err);
				})
			},cb);
		});
	}

	this.undo = function (trs, sender, cb) {
		var multiInvert = Diff.reverse(trs.asset.multisignature.keysgroup);

		private.unconfirmedSignatures[sender.address] = true;
		this.scope.account.merge(sender.address, {
			multisignatures: multiInvert,
			multimin: -trs.asset.multisignature.min,
			multilifetime: -trs.asset.multisignature.lifetime
		}, cb);
	}

	this.applyUnconfirmed = function (trs, sender, cb) {
		if (private.unconfirmedSignatures[sender.address]) {
			return setImmediate(cb, "Signature on this account wait for confirmation");
		}

		if (sender.multisignatures.length) {
			return setImmediate(cb, "This account already have multisignature");
		}

		private.unconfirmedSignatures[sender.address] = true;

		this.scope.account.merge(sender.address, {
			u_multisignatures: trs.asset.multisignature.keysgroup,
			u_multimin: trs.asset.multisignature.min,
			u_multilifetime: trs.asset.multisignature.lifetime
		}, function (err) {
			cb();
		});
	}

	this.undoUnconfirmed = function (trs, sender, cb) {
		var multiInvert = Diff.reverse(trs.asset.multisignature.keysgroup);

		private.unconfirmedSignatures[sender.address] = false;
		this.scope.account.merge(sender.address, {
			u_multisignatures: multiInvert,
			u_multimin: -trs.asset.multisignature.min,
			u_multilifetime: -trs.asset.multisignature.lifetime
		}, cb);
	}

	this.objectNormalize = function (trs) {
		var report = library.scheme.validate(trs.asset.multisignature, {
			type: "object",
			properties: {
				min: {
					type: "integer",
					minimum: 1,
					maximum: 15
				},
				keysgroup: {
					type: "array",
					minLength: 1,
					maxLength: 16
				},
				lifetime: {
					type: "integer",
					minimum: 1,
					maximum: 24
				}
			},
			required: ['min', 'keysgroup', 'lifetime']
		});

		if (!report) {
			throw Error(report.getLastError());
		}

		return trs;
	}

	this.dbRead = function (raw) {
		if (!raw.m_keysgroup) {
			return null
		} else {
			var multisignature = {
				min: raw.m_min,
				lifetime: raw.m_lifetime,
				keysgroup: raw.m_keysgroup.split(',')
			}

			return {multisignature: multisignature};
		}
	}

	this.dbSave = function (trs, cb) {
		library.dbLite.query("INSERT INTO multisignatures(min, lifetime, keysgroup, transactionId) VALUES($min, $lifetime, $keysgroup, $transactionId)", {
			min: trs.asset.multisignature.min,
			lifetime: trs.asset.multisignature.lifetime,
			keysgroup: trs.asset.multisignature.keysgroup.join(','),
			transactionId: trs.id
		}, function (err, rows) {
			if (err) {
				return cb(err);
			} else {
				library.network.io.sockets.emit('mutlsigiantures/change', {});
				return cb();
			}
		});
	}

	this.ready = function (trs, sender) {
		if (!trs.signatures) {
			return false;
		}

		if (!sender.multisignatures.length) {
			return trs.signatures.length == trs.asset.multisignature.keysgroup.length;
		} else {
			return trs.signatures.length >= sender.multimin - 1;
		}
	}
}

//constructor
function Multisignatures(cb, scope) {
	library = scope;
	genesisblock = library.genesisblock;
	self = this;
	self.__private = private;
	private.attachApi();

	library.logic.transaction.attachAssetType(TransactionTypes.MULTI, new Multisignature());

	setImmediate(cb, null, self);
}

//private methods
private.attachApi = function () {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) return next();
		res.status(500).send({success: false, error: errorCode('COMMON.LOADING')});
	});

	router.map(shared, {
		"get /pending": "pending", // get pendings transactions
		"post /sign": "sign", // sign transaction
		"put /": "addMultisignature", // enable
		"get /accounts": "getAccounts"
	});

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: errorCode('COMMON.INVALID_API')});
	});

	library.network.app.use('/api/multisignatures', router);
	library.network.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error(req.url, err.toString());
		res.status(500).send({success: false, error: err.toString()});
	});
}

//public methods
Multisignatures.prototype.sandboxApi = function (call, args, cb) {
	sandboxHelper.callMethod(shared, call, args, cb);
}

//events
Multisignatures.prototype.onBind = function (scope) {
	modules = scope;
}

shared.getAccounts = function (req, cb) {
	var query = req.body;

	library.scheme.validate(query, {
		type: "object",
		properties: {
			publicKey: {
				type: "string",
				format: "publicKey"
			}
		},
		required: ['publicKey']
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		library.dbLite.query("select GROUP_CONCAT(accountId) from mem_accounts2multisignatures where dependentId = $publicKey", {
			publicKey: query.publicKey
		}, ['accountId'], function (err, rows) {
			if (err) {
				library.logger.error(err.toString());
				return cb("Internal sql error");
			}

			var addresses = rows[0].accountId.split(',');

			modules.accounts.getAccounts({
				address: {$in: addresses},
				sort: 'balance'
			}, ['address', 'balance', 'multisignatures', 'multilifetime', 'multimin'], function (err, rows) {
				if (err) {
					library.logger.error(err);
					return cb("Internal sql error");
				}

				async.eachSeries(rows, function (account, cb) {
					var addresses = [];
					for (var i = 0; i < account.multisignatures.length; i++) {
						addresses.push(modules.accounts.generateAddressByPublicKey(account.multisignatures[i]));
					}

					modules.accounts.getAccounts({
						address: {$in: addresses}
					}, ['address', 'publicKey', 'balance', 'username'], function (err, multisigaccounts) {
						if (err) {
							return cb(err);
						}

						account.multisigaccounts = multisigaccounts;
						return cb();
					});
				}, function (err) {
					if (err) {
						return cb(err);
					}

					return cb(null, {accounts: rows});
				});
			});
		});
	});
}

//shared
shared.pending = function (req, cb) {
	var query = req.body;

	library.scheme.validate(query, {
		type: "object",
		properties: {
			publicKey: {
				type: "string",
				format: "publicKey"
			}
		},
		required: ['publicKey']
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		var transactions = modules.transactions.getUnconfirmedTransactionList();

		var pendings = [];
		async.eachSeries(transactions, function (item, cb) {
			var signed = false;

			if (!verify && item.signatures && item.signatures.length > 0) {
				var verify = false;

				for (var i in item.signatures) {
					var signature = item.signatures[i];

					try {
						verify = library.logic.transaction.verifySignature(item, query.publicKey, item.signatures[i]);
					} catch (e) {
						verify = false;
					}

					if (verify) {
						break;
					}
				}

				if (verify) {
					signed = true;
				}
			}


			if (!signed && item.senderPublicKey == query.publicKey) {
				signed = true;
			}

			modules.accounts.getAccount({
				publicKey: item.senderPublicKey
			}, function (err, sender) {
				if (err) {
					return cb(err);
				}

				if ((sender.publicKey == query.publicKey && sender.u_multisignatures.length > 0) || sender.u_multisignatures.indexOf(query.publicKey) >= 0 || sender.multisignatures.indexOf(query.publicKey) >= 0) {
					var min = sender.u_multimin || sender.multimin;
					var lifetime = sender.u_multilifetime || sender.multilifetime;
					var signatures = sender.u_multisignatures.length;

					pendings.push({
						max: signatures.length,
						min: min,
						lifetime: lifetime,
						signed: signed,
						transaction: item
					});
				}

				return cb();
			});
		}, function () {
			return cb(null, {transactions: pendings});
		});
	});
}

Multisignatures.prototype.processSignature = function (tx, cb) {
	var transaction = modules.transactions.getUnconfirmedTransaction(tx.transaction);

	function done(cb) {
		library.balancesSequence.add(function (cb) {
			var transaction = modules.transactions.getUnconfirmedTransaction(tx.transaction);

			if (!transaction) {
				return cb("Transaction not found");
			}

			transaction.signatures = transaction.signatures || [];
			transaction.signatures.push(tx.signature);
			library.bus.message('signature', transaction, true);

			cb();
		}, cb);
	}

	if (!transaction) {
		return cb(errorCode("TRANSACTIONS.TRANSACTION_NOT_FOUND"));
	}

	if (transaction.type == TransactionTypes.MULTI) {
		transaction.signatures = transaction.signatures || [];

		if (transaction.asset.multisignature.signatures || transaction.signatures.indexOf(tx.signature) != -1) {
			return cb(errorCode("MULTISIGNATURES.SIGN_NOT_ALLOWED", transaction));
		}

		// find public key
		var verify = false;

		try {
			for (var i = 0; i < transaction.asset.multisignature.keysgroup.length && !verify; i++) {
				var key = transaction.asset.multisignature.keysgroup[i].substring(1);
				verify = library.logic.transaction.verifySignature(transaction, key, tx.signature);
			}
		} catch (e) {
			return cb("Failed to signature verification, exception");
		}

		if (!verify) {
			return cb("Failed to signature verification")
		}

		done(cb);
	} else {
		modules.accounts.getAccount({
			address: transaction.senderId
		}, function (err, account) {
			if (err) {
				return cb("Error, account for multisignature transaction not found");
			}

			var verify = false;
			var multisignatures = account.multisignatures;

			if (transaction.requesterPublicKey) {
				multisignatures.push(transaction.senderPublicKey);
			}


			transaction.signatures = transaction.signatures || [];

			if (transaction.signatures.indexOf(tx.signature) >= 0) {
				return cb("This signature already exists");
			}

			try {
				for (var i = 0; i < multisignatures.length && !verify; i++) {
					verify = library.logic.transaction.verifySignature(transaction, multisignatures[i], tx.signature);
				}
			} catch (e) {
				return cb("Failed to verify signature: " + transaction.id);
			}

			if (!verify) {
				return cb("Failed to verify signature: " + transaction.id);
			}

			library.network.io.sockets.emit('mutlsigiantures/singature/change', {});
			return done(cb);
		});
	}
}

shared.sign = function (req, cb) {
	var body = req.body;
	library.scheme.validate(body, {
		type: "object",
		properties: {
			secret: {
				type: "string",
				minLength: 1,
				maxLength: 100
			},
			secondSecret: {
				type: "string",
				minLength: 1,
				maxLength: 100
			},
			publicKey: {
				type: "string",
				format: "publicKey"
			},
			transactionId: {
				type: "string"
			}
		},
		required: ['transactionId', 'secret']
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		var transaction = modules.transactions.getUnconfirmedTransaction(body.transactionId);

		if (!transaction) {
			return cb(errorCode("TRANSACTIONS.TRANSACTION_NOT_FOUND"));
		}

		var hash = crypto.createHash('sha256').update(body.secret, 'utf8').digest();
		var keypair = ed.MakeKeypair(hash);

		if (body.publicKey) {
			if (keypair.publicKey.toString('hex') != body.publicKey) {
				return cb(errorCode("COMMON.INVALID_SECRET_KEY"));
			}
		}

		var sign = library.logic.transaction.multisign(keypair, transaction);

		function done(cb) {
			library.balancesSequence.add(function (cb) {
				var transaction = modules.transactions.getUnconfirmedTransaction(body.transactionId);

				if (!transaction) {
					return cb("Transaction not found");
				}

				transaction.signatures = transaction.signatures || [];
				transaction.signatures.push(sign);

				library.bus.message('signature', {
					signature: sign,
					transaction: transaction.id
				}, true);
				cb();
			}, function (err) {
				if (err) {
					return cb(err.toString());
				}

				cb(null, {transactionId: transaction.id});
			});
		}

		if (transaction.type == TransactionTypes.MULTI) {
			if (transaction.asset.multisignature.keysgroup.indexOf("+" + keypair.publicKey.toString('hex')) == -1 || (transaction.signatures && transaction.signatures.indexOf(sign.toString('hex')) != -1)) {
				return cb(errorCode("MULTISIGNATURES.SIGN_NOT_ALLOWED", transaction));
			}

			library.network.io.sockets.emit('mutlsigiantures/singature/change', {});
			done(cb);
		} else {
			modules.accounts.getAccount({
				address: transaction.senderId
			}, function (err, account) {
				if (err) {
					return cb("Error, account for multisignature transaction not found");
				}

				if (!transaction.requesterPublicKey) {
					if (account.multisignatures.indexOf(keypair.publicKey.toString('hex')) < 0) {
						return cb(errorCode("MULTISIGNATURES.SIGN_NOT_ALLOWED", transaction));
					}
				} else {
					if (account.publicKey != keypair.publicKey.toString('hex') || transaction.senderPublicKey != keypair.publicKey.toString('hex')) {
						return cb(errorCode("MULTISIGNATURES.SIGN_NOT_ALLOWED", transaction));
					}
				}

				if (transaction.signatures && transaction.signatures.indexOf(sign) != -1) {
					return cb(errorCode("MULTISIGNATURES.SIGN_NOT_ALLOWED", transaction));
				}

				library.network.io.sockets.emit('mutlsigiantures/singature/change', {});
				done(cb);
			});
		}
	});
}

shared.addMultisignature = function (req, cb) {
	var body = req.body;
	library.scheme.validate(body, {
		type: "object",
		properties: {
			secret: {
				type: "string",
				minLength: 1,
				maxLength: 100
			},
			publicKey: {
				type: "string",
				format: "publicKey"
			},
			secondSecret: {
				type: "string",
				minLength: 1,
				maxLength: 100
			},
			min: {
				type: "integer",
				minimum: 1,
				maximum: 16
			},
			lifetime: {
				type: "integer",
				minimum: 1,
				maximum: 24
			},
			keysgroup: {
				type: "array",
				minLength: 1,
				maxLength: 10
			}
		},
		required: ['min', 'lifetime', 'keysgroup', 'secret']
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		var hash = crypto.createHash('sha256').update(body.secret, 'utf8').digest();
		var keypair = ed.MakeKeypair(hash);

		if (body.publicKey) {
			if (keypair.publicKey.toString('hex') != body.publicKey) {
				return cb(errorCode("COMMON.INVALID_SECRET_KEY"));
			}
		}

		library.balancesSequence.add(function (cb) {
			modules.accounts.getAccount({publicKey: keypair.publicKey.toString('hex')}, function (err, account) {
				if (err) {
					return cb(err.toString());
				}
				if (!account || !account.publicKey) {
					return cb(errorCode("COMMON.OPEN_ACCOUNT"));
				}

				if (account.secondSignature && !body.secondSecret) {
					return cb(errorCode("COMMON.SECOND_SECRET_KEY"));
				}

				var secondKeypair = null;

				if (account.secondSignature) {
					var secondHash = crypto.createHash('sha256').update(body.secondSecret, 'utf8').digest();
					secondKeypair = ed.MakeKeypair(secondHash);
				}

				try {
					var transaction = library.logic.transaction.create({
						type: TransactionTypes.MULTI,
						sender: account,
						keypair: keypair,
						secondKeypair: secondKeypair,
						min: body.min,
						keysgroup: body.keysgroup,
						lifetime: body.lifetime
					});
				} catch (e) {
					return cb(e.toString());
				}

				modules.transactions.receiveTransactions([transaction], cb);
			});
		}, function (err, transaction) {
			if (err) {
				return cb(err.toString());
			}

			library.network.io.sockets.emit('mutlsigiantures/change', {});
			cb(null, {transactionId: transaction[0].id});
		});
	});
}


//export
module.exports = Multisignatures;