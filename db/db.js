var sqlite3 = require('sqlite3'),
    path = require('path'),
    async = require('async'),
    _ = require('underscore'),
    ByteBuffer = require('bytebuffer'),
    EventEmitter = require('events').EventEmitter,
    util = require('util'),
    bignum = require('bignum');

var db = function (path) {
    this.path = path;

    this.queue = [];
    this.blockSavingId = null;

    this.open();
}

util.inherits(db, EventEmitter);

db.prototype.setApp = function (app) {
    this.app = app;
}

db.prototype.open = function () {
    this.sql = new sqlite3.cached.Database(this.path);
}

db.prototype.close = function () {
    this.sql.close();
    this.sql = null;
}


db.prototype.writeBlock = function (block,  callback) {
    var sql = this.sql,
        updateNextBlock = this.updateNextBlock;

    sql.serialize(function () {
        var previousBlock = null;
        if (block.previousBlock) {
            previousBlock = bignum(block.previousBlock).toBuffer({ size: 8 })
        }

        var st = sql.prepare("INSERT INTO blocks(id, version, timestamp, previousBlock, numberOfRequests, numberOfTransactions, numberOfConfirmations, totalAmount, totalFee, payloadLength, requestsLength, confirmationsLength, payloadHash, generatorPublicKey, generationSignature, blockSignature, height) VALUES($id, $version, $timestamp, $previousBlock, $numberOfRequests, $numberOfTransactions, $numberOfConfirmations, $totalAmount, $totalFee, $payloadLength, $requestsLength, $confirmationsLength, $payloadHash, $generatorPublicKey, $generationSignature, $blockSignature, $height)");
        st.bind({
            $id : bignum(block.getId()).toBuffer({ size : 8 }),
            $version : block.version,
            $timestamp : block.timestamp,
            $previousBlock : previousBlock,
            $numberOfRequests : block.numberOfRequests,
            $numberOfTransactions : block.numberOfTransactions,
            $numberOfConfirmations : block.numberOfConfirmations,
            $totalAmount : block.totalAmount,
            $totalFee : block.totalFee,
            $payloadLength : block.payloadLength,
            $requestsLength : block.requestsLength,
            $confirmationsLength : block.confirmationsLength,
            $payloadHash : block.payloadHash,
            $generatorPublicKey : block.generatorPublicKey,
            $generationSignature : block.generationSignature,
            $blockSignature : block.blockSignature,
            $height : block.height
        });

        st.run(function (err) {
            if (err) {
                return callback(err);
            } else {
                var blockRowId = this.lastID;
                block.setRowId(blockRowId);

                async.series([
                    function (cb) {
                        async.eachSeries(block.transactions, function (transaction, c) {
                            sql.serialize(function () {
                                var st = sql.prepare("INSERT INTO trs(id, blockId, blockRowId, type, subtype, timestamp, senderPublicKey, sender, recipientId, amount, fee, signature,signSignature) VALUES($id, $blockId, $blockRowId, $type, $subtype, $timestamp, $senderPublicKey, $sender, $recipientId, $amount, $fee, $signature, $signSignature)")
                                st.bind({
                                    $id : bignum(transaction.getId()).toBuffer({ size : 8 }),
                                    $blockId : bignum(block.getId()).toBuffer({ size : 8 }),
                                    $blockRowId : blockRowId,
                                    $type : transaction.type,
                                    $subtype : transaction.subtype,
                                    $timestamp : transaction.timestamp,
                                    $senderPublicKey : transaction.senderPublicKey,
                                    $sender : bignum(transaction.sender.substring(0, transaction.sender.length - 1)).toBuffer({ size : 8 }),
                                    $recipientId : bignum(transaction.recipientId).toBuffer({ size : 8 }),
                                    $amount : transaction.amount,
                                    $fee : transaction.fee,
                                    $signature : transaction.signature,
                                    $signSignature : transaction.signSignature
                                })

                                st.run(function (err) {
                                    if (err) {
                                        return c(err);
                                    } else {
                                        var transactionRowId = this.lastID;
                                        transaction.setRowId(transactionRowId);

                                        if (transaction.type == 2 && transaction.subtype == 0) {
                                            sql.serialize(function () {
                                                st = sql.prepare("INSERT INTO signatures(id, transactionId, transactionRowId, timestamp, publicKey, generatorPublicKey, signature, generationSignature) VALUES($id, $transactionId, $transactionRowId, $timestamp, $publicKey, $generatorPublicKey, $signature, $generationSignature)");
                                                st.bind({
                                                    $id : bignum(transaction.asset.getId()).toBuffer({ size : 8 }),
                                                    $transactionId : bignum(transaction.getId()).toBuffer({ size : 8 }),
                                                    $timestamp : transaction.asset.timestamp,
                                                    $publicKey : transaction.asset.publicKey,
                                                    $generatorPublicKey : transaction.asset.generatorPublicKey,
                                                    $signature : transaction.asset.signature,
                                                    $generationSignature : transaction.asset.generationSignature,
                                                    $transactionRowId : transactionRowId
                                                });

                                                st.run(function (err) {
                                                    if (!err) {
                                                        transaction.asset.setRowId(this.lastID);
                                                    }

                                                    return c(err);
                                                });
                                            });
                                        } else if (transaction.type == 3 && transaction.subtype == 0) {
                                            sql.serialize(function () {
                                                st = sql.prepare("INSERT INTO companies(id, transactionId, transactionRowId, name, description, domain, email, timestamp, generatorPublicKey, signature) VALUES($id, $transactionId, $transactionRowId, $name, $description, $domain, $email, $timestamp, $generatorPublicKey, $signature)");
                                                st.bind({
                                                    $id : bignum(transaction.asset.getId()).toBuffer({ size : 8 }),
                                                    $transactionId : bignum(transaction.getId()).toBuffer({ size : 8 }),
                                                    $name : transaction.asset.name,
                                                    $description : transaction.asset.description,
                                                    $email : transaction.asset.email,
                                                    $timestamp : transaction.asset.timestamp,
                                                    $generatorPublicKey : transaction.asset.generatorPublicKey,
                                                    $signature : transaction.asset.signature,
                                                    $transactionRowId : transactionRowId
                                                });

                                                st.run(function (err) {
                                                    if (!err) {
                                                        transaction.asset.setRowId(this.lastID);
                                                    }

                                                    return c(err);
                                                });
                                            });
                                        } else {
                                            c();
                                        }
                                    }
                                });
                            });
                        }, function (err) {
                            return cb(err);
                        });
                    },
                    function (cb) {
                        async.eachSeries(block.requests, function (request, c) {
                            sql.serialize(function () {
                                var st = sql.prepare("INSERT INTO requests(id, blockId, blockRowId, address) VALUES($id, $blockId, $blockRowId, $address)");
                                st.bind({
                                    $id : bignum(request.getId()).toBuffer({ size : 8 }),
                                    $address : bignum(request.address.substr(0, request.address.length - 1)).toBuffer({ size : 8 }),
                                    $blockId : bignum(block.getId()).toBuffer({ size : 8 }),
                                    $blockRowId : blockRowId
                                });

                                st.run(function (err) {
                                    if (!err) {
                                        request.setRowId(this.lastID);
                                    }

                                    return c(err);
                                });
                            });
                        }, function (err) {
                            cb(err);
                        });
                    },
                    function (cb) {
                        async.eachSeries(block.confirmations, function (confirmation, c) {
                            sql.serialize(function () {
                                var st = sql.prepare("INSERT INTO companyconfirmations(id, blockId, blockRowId, companyId, verified, timestamp, signature) VALUES($id, $blockId, $blockRowId, $companyId, $verified, $timestamp, $signature)");
                                st.bind({
                                    $id : bignum(confirmation.getId()).toBuffer({ size : 8 }),
                                    $blockId : bignum(block.getId()).toBuffer({ size : 8 }),
                                    $companyId : bignum(confirmation.companyId).toBuffer({ size : 8 }),
                                    $verified : confirmation.verified,
                                    $timestamp : confirmation.timestamp,
                                    $signature : confirmation.signature,
                                    $blockRowId : blockRowId
                                });

                                st.run(function (err) {
                                    if (!err) {
                                        confirmation.setRowId(this.lastID);
                                    }

                                    return c(err);
                                });
                            });
                        }, function (err) {
                            cb(err);
                        });
                    }
                ], function (err) {
                    if (err) {
                        console.log(err);
                    }

                    return callback(err);
                });
            }
        });
    });
}

db.prototype.getAssetOfTransaction = function (transactionId, type, subtype, callback) {
    var sql = this.sql;

    sql.serialize(function () {
        var st = null;

        if (type == 2 && subtype == 0) {
            st = sql.prepare("SELECT * FROM signatures WHERE transactionId = $transactionId");
            st.bind({
                $transactionId : bignum(transactionId).toBuffer({ size : 8 })
            });

            st.get(function (err, signature) {
                return callback(err, signature);
            })
        } else if (type == 3 && subtype == 0) {
            st = sql.prepare("SELECT * FROM companies WHERE transactionId = $transactionId");
            st.bind({
                $transactionId : bignum(transactionId).toBuffer({ size : 8 })
            });

            st.get(function (err, company) {
                return callback(err, company);
            });
        } else {
            return callback("Transaction has not asset");
        }
    });
}

db.prototype.getTransactionsOfBlock = function (blockId, callback) {
    var sql = this.sql,
        getAssetOfTransaction = this.getAssetOfTransaction;

    sql.serialize(function () {
        var st = sql.prepare("SELECT * FROM trs WHERE blockId = $blockId");
        st.bind({
            $blockId : bignum(blockId).toBuffer({ size : 8 })
        });

        st.all(function (err, transactions) {
            if (err) {
                return callback(err);
            } else {
                async.eachSeries(transactions, function (transaction, cb) {
                    if (transaction.type != 0) {
                        getAssetOfTransaction(transaction.id, transaction.type, transaction.subtype, function (err, asset) {
                            if (err) {
                                return cb(err);
                            } else {
                                transaction.asset = asset;
                                return cb();
                            }
                        });
                    } else {
                        return cb();
                    }
                }, function (err) {
                    return callback(err);
                });
            }
        });
    });
}

db.prototype.getRequestsOfBlock = function (blockId, callback) {
    var sql = this.sql;

    sql.serialize(function () {
        var st = sql.prepare("SELECT * FROM requests WHERE blockId = $blockId");
        st.bind({
            $blockId : bignum(blockId).toBuffer({ size : 8 })
        });

        st.all(function (err, requests) {
            return callback(err, requests);
        });
    });
}

db.prototype.getConfirmationsOfBlock = function (blockId, callback) {
    var sql = this.sql;

    sql.serialize(function () {
        var st = sql.prepare("SELECT * FROM companyconfirmations WHERE blockId = $blockId");
        st.bind({
            $blockId : bignum(blockId).toBuffer({ size : 8 })
        });

        st.all(function (err, companyconfirmations) {
            return callback(err, companyconfirmations);
        });
    });
}

db.prototype.deleteFromHeight = function (height, callback) {
    var sql = this.sql;

    sql.serialize(function () {
        var st = sql.prepare("DELETE FROM blocks WHERE height >= $height");
        st.bind({
            $height : height
        });

        st.run(function (err) {
            return callback(err);
        });
    });
}

db.prototype.deleteBlock = function (rowId, callback) {
    var sql = this.sql;

    sql.serialize(function () {
        var st = sql.prepare("DELETE FROM blocks WHERE rowId = $rowId");
        st.bind({
            $rowId : rowId
        });

        st.run(function (err) {
            return callback(err);
        });
    });
}

db.prototype.readBlocks = function (callback) {
    var sql = this.sql;

    sql.serialize(function () {
        sql.all("SELECT rowid, * FROM blocks ORDER BY height", function (err, blocks) {
            callback(err, blocks);
        });
    })
}

module.exports.initDb = function (path, app, callback) {
    var d = new db(path);
    d.setApp(app);
    app.db = d;

    d.sql.serialize(function () {
        async.series([
            function (cb) {
                d.sql.run("CREATE TABLE IF NOT EXISTS blocks (id BINARY(8) UNIQUE, version INT NOT NULL, timestamp INT NOT NULL, height INT NOT NULL, previousBlock BINARY(8), numberOfRequests INT NOT NULL, numberOfTransactions INT NOT NULL, numberOfConfirmations INT NOT NULL, totalAmount BIGINT NOT NULL, totalFee BIGINT NOT NULL, payloadLength INT NOT NULL, requestsLength INT NOT NULL, confirmationsLength INT NOT NULL, payloadHash BINARY(32) NOT NULL, generatorPublicKey BINARY(32) NOT NULL, generationSignature BINARY(64) NOT NULL, blockSignature BINARY(64) NOT NULL, FOREIGN KEY (previousBlock) REFERENCES blocks(id))", cb);
            },
            function (cb) {
                d.sql.run("CREATE TABLE IF NOT EXISTS trs (id BINARY(8) UNIQUE, blockId BINARY(8) NOT NULL, blockRowId INTEGER NOT NULL, type TINYINT NOT NULL, subtype TINYINT NOT NULL, timestamp INT NOT NULL, senderPublicKey BINARY(32) NOT NULL, sender BINARY(8) NOT NULL, recipientId BINARY(8) NOT NULL, amount BIGINT NOT NULL, fee BIGINT NOT NULL, signature BINARY(64) NOT NULL, signSignature BINARY(64), FOREIGN KEY(blockId) REFERENCES blocks(id), FOREIGN KEY(blockRowId) REFERENCES blocks(rowid) ON DELETE CASCADE)", cb);
            },
            function (cb) {
                d.sql.run("CREATE TABLE IF NOT EXISTS requests (id BINARY(8) UNIQUE, blockId BINARY(8) NOT NULL, blockRowId INTEGER NOT NULL, address BINARY(8) NOT NULL, FOREIGN KEY(blockId) REFERENCES blocks(id), FOREIGN KEY(blockRowId) REFERENCES blocks(rowid) ON DELETE CASCADE)", cb);
            },
            function (cb) {
                d.sql.run("CREATE TABLE IF NOT EXISTS signatures (id BINARY(8) UNIQUE, transactionId BINARY(8) NOT NULL, transactionRowId INTEGER NOT NULL, timestamp INT NOT NULL, publicKey BINARY(32) NOT NULL, generatorPublicKey BINARY(32) NOT NULL, signature BINARY(64) NOT NULL, generationSignature BINARY(64) NOT NULL, FOREIGN KEY(transactionId) REFERENCES trs(id), FOREIGN KEY(transactionRowId) REFERENCES trs(rowid) ON DELETE CASCADE)", cb);
            },
            function (cb) {
                d.sql.run("CREATE TABLE IF NOT EXISTS companies (id BINARY(8) UNIQUE, transactionId BINARY(8) NOT NULL, transactionRowId INTEGER NOT NULL, name VARCHAR(20) NOT NULL, description VARCHAR(250) NOT NULL, domain TEXT, email TEXT NOT NULL, timestamp INT NOT NULL, generatorPublicKey BINARY(32) NOT NULL, signature BINARY(32) NOT NULL, FOREIGN KEY(transactionId) REFERENCES trs(id), FOREIGN KEY(transactionRowId) REFERENCES trs(rowid) ON DELETE CASCADE)", cb)
            },
            function (cb) {
                d.sql.run("CREATE TABLE IF NOT EXISTS companyconfirmations (id BINARY(8) UNIQUE, blockId BINARY(8) NOT NULL, blockRowId INTEGER NOT NULL, companyId BINARY(8) NOT NULL, verified TINYINT(1) NOT NULL, timestamp INT NOT NULL, signature BINARY(64) NOT NULL, FOREIGN KEY(blockId) REFERENCES blocks(id), FOREIGN KEY(blockRowId) REFERENCES blocks(rowid) ON DELETE CASCADE)", cb);
            },
            function (cb) {
                d.sql.run("CREATE INDEX IF NOT EXISTS block_row_trs_id ON trs (blockRowId)", cb);
            },
            function (cb) {
                d.sql.run("CREATE INDEX IF NOT EXISTS block_row_requests_id ON requests(blockRowId)", cb);
            },
            function (cb) {
                d.sql.run("CREATE INDEX IF NOT EXISTS transaction_row_signatures_id ON signatures(transactionRowId)", cb);
            },
            function (cb) {
                d.sql.run("CREATE INDEX IF NOT EXISTS transaction_row_companies_id ON companies(transactionRowId)", cb);
            },
            function (cb) {
                d.sql.run("CREATE INDEX IF NOT EXISTS block_row_confirmations_id ON companyconfirmations(blockId)", cb);
            },
            function (cb) {
                d.sql.run("CREATE INDEX IF NOT EXISTS block_height ON blocks(height)", cb);
            }
        ], function (err) {
            if (err) {
                console.log(err);
            }
            callback(err, d);
        });
    });
}