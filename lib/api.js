/** @namespace Client.API */
'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var util = require('util');
var async = require('async');
var events = require('events');
var WalletUtils = require('bitcore-wallet-utils');
var Bitcore = WalletUtils.Bitcore;
var sjcl = require('sjcl');

var request;
if (process && !process.browser) {
  request = require('request');
}
else {
  request = require('browser-request');
}

var log = require('./log');
var Credentials = require('./credentials');
var Verifier = require('./verifier');
var ServerCompromisedError = require('./servercompromisederror');
var ClientError = require('./clienterror');

var BASE_URL = 'http://localhost:3001/bws/api';

/**
 * @desc ClientAPI constructor.
 *
 * @param {Object} opts
 * @constructor
 */
function API(opts) {
  opts = opts || {};

  this.verbose = !!opts.verbose;
  this.request = opts.request || request;
  this.baseUrl = opts.baseUrl || BASE_URL;
  this.basePath = this.baseUrl.replace(/http.?:\/\/[a-zA-Z0-9:-]*\//, '/');
  if (this.verbose) {
    log.setLevel('debug');
  } else {
    log.setLevel('info');
  }
};

util.inherits(API, events.EventEmitter);

/**
 * Encrypt a message
 * @private
 * @static
 * @memberof Client.API
 * @param {String} message
 * @param {String} encryptingKey
 */
API._encryptMessage = function(message, encryptingKey) {
  if (!message) return null;
  return WalletUtils.encryptMessage(message, encryptingKey);
};

/**
 * Decrypt a message
 * @private
 * @static
 * @memberof Client.API
 * @param {String} message
 * @param {String} encryptingKey
 */
API._decryptMessage = function(message, encryptingKey) {
  if (!message) return '';
  try {
    return WalletUtils.decryptMessage(message, encryptingKey);
  } catch (ex) {
    return '<ECANNOTDECRYPT>';
  }
};

/**
 * Decrypt text fields in transaction proposals
 * @private
 * @static
 * @memberof Client.API
 * @param {Array} txps
 * @param {String} encryptingKey
 */
API._processTxps = function(txps, encryptingKey) {
  if (!txps) return;
  _.each([].concat(txps), function(txp) {
    txp.encryptedMessage = txp.message;
    txp.message = API._decryptMessage(txp.message, encryptingKey);
    _.each(txp.actions, function(action) {
      action.comment = API._decryptMessage(action.comment, encryptingKey);
    });
  });
};

/**
 * Parse errors
 * @private
 * @static
 * @memberof Client.API
 * @param {Object} body
 */
API._parseError = function(body) {
  if (_.isString(body)) {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {
        error: body
      };
    }
  }
  var ret;
  if (body && body.code) {
    ret = new ClientError(body.code, body.message);
  } else {
    ret = {
      code: 'ERROR',
      error: body ? body.error : 'There was an unknown error processing the request',
    };
  }
  log.error(ret);
  return ret;
};

/**
 * Sign an HTTP request
 * @private
 * @static
 * @memberof Client.API
 * @param {String} method - The HTTP method
 * @param {String} url - The URL for the request
 * @param {Object} args - The arguments in case this is a POST/PUT request
 * @param {String} privKey - Private key to sign the request
 */
API._signRequest = function(method, url, args, privKey) {
  var message = [method.toLowerCase(), url, JSON.stringify(args)].join('|');
  return WalletUtils.signMessage(message, privKey);
};


/**
 * Seed from random
 *
 * @param {String} network
 */
API.prototype.seedFromRandom = function(network) {
  this.credentials = Credentials.create(network);
};

/**
 * Seed from extended private key
 *
 * @param {String} xPrivKey
 */
API.prototype.seedFromExtendedPrivateKey = function(xPrivKey) {
  this.credentials = Credentials.fromExtendedPrivateKey(xPrivKey);
};

/**
 * Export wallet
 *
 * @param {Object} opts
 * @param {Boolean} opts.compressed
 * @param {Boolean} opts.noSign
 */
API.prototype.export = function(opts) {
  $.checkState(this.credentials);

  opts = opts || {};

  var output;

  var cred = Credentials.fromObj(this.credentials);
  if (opts.noSign) {
    delete cred.xPrivKey;
  }

  if (opts.compressed) {
    output = cred.exportCompressed();
  } else {
    output = JSON.stringify(cred.toObj());
  }

  return output;
}


/**
 * Import wallet
 *
 * @param {Object} opts
 * @param {Boolean} opts.compressed
 */
API.prototype.import = function(str, opts) {
  opts = opts || {};

  var credentials;
  try {
    if (opts.compressed) {
      credentials = Credentials.importCompressed(str);
      // HACK: simulate incomplete credentials
      delete credentials.m;
    } else {
      credentials = Credentials.fromObj(JSON.parse(str));
    }
  } catch (ex) {
    throw new Error('Error importing from source');
  }
  this.credentials = credentials;
};

/**
 * Do an HTTP request
 * @private
 *
 * @param {Object} method
 * @param {String} url
 * @param {Object} args
 * @param {Callback} cb
 */
API.prototype._doRequest = function(method, url, args, cb) {
  $.checkState(this.credentials);

  var reqSignature;

  if (this.credentials.requestPrivKey) {
    reqSignature = API._signRequest(method, url, args, this.credentials.requestPrivKey);
  }

  var absUrl = this.baseUrl + url;
  var args = {
    // relUrl: only for testing with `supertest`
    relUrl: this.basePath + url,
    headers: {
      'x-identity': this.credentials.copayerId,
      'x-signature': reqSignature
    },
    method: method,
    url: absUrl,
    body: args,
    json: true,
    withCredentials: false
  };

  log.debug('Request Args', util.inspect(args, {
    depth: 10
  }));
  this.request(args, function(err, res, body) {
    log.debug(util.inspect(body, {
      depth: 10
    }));
    if (err) return cb(err);

    if (res.statusCode != 200) {
      return cb(API._parseError(body));
    }

    return cb(null, body, res.header);
  });
};

/**
 * Do a POST request
 * @private
 *
 * @param {String} url
 * @param {Object} args
 * @param {Callback} cb
 */
API.prototype._doPostRequest = function(url, args, cb) {
  return this._doRequest('post', url, args, cb);
};

/**
 * Do a GET request
 * @private
 *
 * @param {String} url
 * @param {Callback} cb
 */
API.prototype._doGetRequest = function(url, cb) {
  return this._doRequest('get', url, {}, cb);
};

/**
 * Do a DELETE request
 * @private
 *
 * @param {String} url
 * @param {Callback} cb
 */
API.prototype._doDeleteRequest = function(url, cb) {
  return this._doRequest('delete', url, {}, cb);
};

/**
 * Join
 * @private
 *
 * @param {String} walletId
 * @param {String} walletPrivKey
 * @param {String} xPubKey
 * @param {String} requestPubKey
 * @param {String} copayerName
 * @param {Callback} cb
 */
API.prototype._doJoinWallet = function(walletId, walletPrivKey, xPubKey, requestPubKey, copayerName, cb) {
  var args = {
    walletId: walletId,
    name: copayerName,
    xPubKey: xPubKey,
    requestPubKey: requestPubKey
  };
  var hash = WalletUtils.getCopayerHash(args.name, args.xPubKey, args.requestPubKey);
  args.copayerSignature = WalletUtils.signMessage(hash, walletPrivKey);

  var url = '/v1/wallets/' + walletId + '/copayers';
  this._doPostRequest(url, args, function(err, body) {
    if (err) return cb(err);
    return cb(null, body.wallet);
  });
};

/**
 * Return if wallet is complete
 */
API.prototype.isComplete = function() {
  return this.credentials && this.credentials.isComplete();
};

API.prototype.canSign = function() {
  return this.credentials && this.credentials.canSign();
};


/**
 * Open a wallet and try to complete the public key ring.
 *
 * @param {Callback} cb - The callback that handles the response. It returns a flag indicating that the wallet is complete.
 * @fires API#walletCompleted
 */
API.prototype.openWallet = function(cb) {
  $.checkState(this.credentials);

  var self = this;

  if (self.credentials.isComplete()) return cb(null, true);

  self._doGetRequest('/v1/wallets/', function(err, ret) {
    if (err) return cb(err);
    var wallet = ret.wallet;

    if (wallet.status != 'complete') return cb(null, false);

    if (self.credentials.walletPrivKey) {
      if (!Verifier.checkCopayers(self.credentials, wallet.copayers)) {
        return cb(new ServerCompromisedError(
          'Copayers in the wallet could not be verified to have known the wallet secret'));
      }
    } else {
      log.warn('Could not perform verification of other copayers in the wallet');
    }

    self.credentials.addPublicKeyRing(_.map(wallet.copayers, function(copayer) {
      return _.pick(copayer, ['xPubKey', 'requestPubKey']);
    }));
    if (!self.credentials.hasWalletInfo()) {
      var me = _.find(wallet.copayers, {
        id: self.credentials.copayerId
      });
      self.credentials.addWalletInfo(wallet.id, wallet.name, wallet.m, wallet.n, null, me.name);
    }

    self.emit('walletCompleted', wallet);

    return cb(null, true);
  });
};

/**
 * Create a wallet.
 *
 * @param {String} walletName
 * @param {String} copayerName
 * @param {Number} m
 * @param {Number} n
 * @param {String} network - 'livenet' or 'testnet'
 * @param {Callback} cb
 * @returns {Callback} cb - Returns the wallet
 */
API.prototype.createWallet = function(walletName, copayerName, m, n, network, cb) {
  var self = this;

  network = network || 'livenet';
  if (!_.contains(['testnet', 'livenet'], network)) return cb(new Error('Invalid network'));

  if (!self.credentials) {
    log.info('Generating new keys');
    self.seedFromRandom(network);
  } else {
    log.info('Using existing keys');
  }

  if (network != self.credentials.network) {
    return cb(new Error('Existing keys were created for a different network'));
  }

  var walletPrivKey = new Bitcore.PrivateKey();
  var args = {
    name: walletName,
    m: m,
    n: n,
    pubKey: walletPrivKey.toPublicKey().toString(),
    network: network,
  };

  self._doPostRequest('/v1/wallets/', args, function(err, body) {
    if (err) return cb(err);

    var walletId = body.walletId;

    var secret = WalletUtils.toSecret(walletId, walletPrivKey, network);
    self.credentials.addWalletInfo(walletId, walletName, m, n, walletPrivKey.toString(), copayerName);

    self._doJoinWallet(walletId, walletPrivKey, self.credentials.xPubKey, self.credentials.requestPubKey, copayerName,
      function(err, wallet) {
        if (err) return cb(err);
        return cb(null, n > 1 ? secret : null);
      });
  });
};

/**
 * Join to an existent wallet
 *
 * @param {String} secret
 * @param {String} copayerName
 * @param {Callback} cb
 * @returns {Callback} cb - Returns the wallet
 */
API.prototype.joinWallet = function(secret, copayerName, cb) {
  var self = this;

  try {
    var secretData = WalletUtils.fromSecret(secret);
  } catch (ex) {
    return cb(ex);
  }

  if (!self.credentials) {
    self.seedFromRandom(secretData.network);
  }

  self._doJoinWallet(secretData.walletId, secretData.walletPrivKey, self.credentials.xPubKey, self.credentials.requestPubKey, copayerName,
    function(err, wallet) {
      if (err) return cb(err);
      self.credentials.addWalletInfo(wallet.id, wallet.name, wallet.m, wallet.n, secretData.walletPrivKey.toString(), copayerName);
      return cb(null, wallet);
    });
};

/**
 * Recreate a wallet
 *
 * @returns {Callback} cb - Returns the wallet
 */
API.prototype.recreateWallet = function(cb) {
  $.checkState(this.credentials && this.credentials.isComplete() && this.credentials.hasWalletInfo());

  var self = this;

  var walletPrivKey = Bitcore.PrivateKey.fromString(self.credentials.walletPrivKey);
  var args = {
    name: self.credentials.walletName || 'recovered wallet',
    m: self.credentials.m,
    n: self.credentials.n,
    pubKey: walletPrivKey.toPublicKey().toString(),
    network: self.credentials.network,
  };
  self._doPostRequest('/v1/wallets/', args, function(err, body) {
    if (err) return cb(err);

    var walletId = body.walletId;

    var i = 1;
    async.each(self.credentials.publicKeyRing, function(item, next) {
      var copayerName;
      if (item.xPubKey == self.credentials.xPubKey) {
        copayerName = self.credentials.copayerName;
      } else {
        copayerName = 'recovered copayer #' + (i++);
      }
      self._doJoinWallet(walletId, walletPrivKey, item.xPubKey, item.requestPubKey, copayerName, next);
    }, cb);
  });
};


/**
 * Get status of the wallet
 *
 * @param {Callback} cb
 * @returns {Callback} cb - Returns error or an object with status information
 */
API.prototype.getStatus = function(cb) {
  $.checkState(this.credentials);
  var self = this;

  self._doGetRequest('/v1/wallets/', function(err, result) {
    if (err) return cb(err);
    if (result.wallet.status == 'pending') {
      var cred = self.credentials;
      result.wallet.secret = WalletUtils.toSecret(cred.walletId, cred.walletPrivKey, cred.network);
    }
    API._processTxps(result.pendingTxps, self.credentials.sharedEncryptingKey);
    return cb(err, result);
  });
};

/**
 * Send a transaction proposal
 *
 * @param {Object} opts
 * @param {String} opts.toAddress
 * @param {Number} opts.amount
 * @param {String} opts.message
 * @returns {Callback} cb - Return error or the transaction proposal
 */
API.prototype.sendTxProposal = function(opts, cb) {
  $.checkState(this.credentials && this.credentials.isComplete());
  $.checkArgument(opts);
  $.shouldBeNumber(opts.amount);

  var self = this;

  var args = {
    toAddress: opts.toAddress,
    amount: opts.amount,
    message: API._encryptMessage(opts.message, self.credentials.sharedEncryptingKey),
  };
  var hash = WalletUtils.getProposalHash(args.toAddress, args.amount, args.message);
  args.proposalSignature = WalletUtils.signMessage(hash, self.credentials.requestPrivKey);
  log.debug('Generating & signing tx proposal hash -> Hash: ', hash, ' Signature: ', args.proposalSignature);

  self._doPostRequest('/v1/txproposals/', args, function(err, txp) {
    if (err) return cb(err);
    return cb(null, txp);
  });
};

/**
 * Create a new address
 *
 * @param {Callback} cb
 * @returns {Callback} cb - Return error or the address
 */
API.prototype.createAddress = function(cb) {
  $.checkState(this.credentials && this.credentials.isComplete());

  var self = this;

  self._doPostRequest('/v1/addresses/', {}, function(err, address) {
    if (err) return cb(err);
    if (!Verifier.checkAddress(self.credentials, address)) {
      return cb(new ServerCompromisedError('Server sent fake address'));
    }

    return cb(null, address);
  });
};

/**
 * Get your main addresses
 *
 * @param {Object} opts
 * @param {Boolean} opts.doNotVerify
 * @param {Callback} cb
 * @returns {Callback} cb - Return error or the array of addresses
 */
API.prototype.getMainAddresses = function(opts, cb) {
  $.checkState(this.credentials && this.credentials.isComplete());

  var self = this;

  self._doGetRequest('/v1/addresses/', function(err, addresses) {
    if (err) return cb(err);

    if (!opts.doNotVerify) {
      var fake = _.any(addresses, function(address) {
        return !Verifier.checkAddress(self.credentials, address);
      });
      if (fake)
        return cb(new ServerCompromisedError('Server sent fake address'));
    }
    return cb(null, addresses);
  });
};

/**
 * Update wallet balance
 *
 * @param {Callback} cb
 */
API.prototype.getBalance = function(cb) {
  $.checkState(this.credentials && this.credentials.isComplete());
  var self = this;

  self._doGetRequest('/v1/balance/', cb);
};

/**
 * Get list of transactions proposals
 *
 * @param {Object} opts
 * @param {Boolean} opts.doNotVerify
 * @param {Boolean} opts.forAirGapped
 * @return {Callback} cb - Return error or array of transactions proposals
 */
API.prototype.getTxProposals = function(opts, cb) {
  $.checkState(this.credentials && this.credentials.isComplete());

  var self = this;

  self._doGetRequest('/v1/txproposals/', function(err, txps) {
    if (err) return cb(err);

    API._processTxps(txps, self.credentials.sharedEncryptingKey);

    var fake = _.any(txps, function(txp) {
      return (!opts.doNotVerify && !Verifier.checkTxProposal(self.credentials, txp));
    });

    if (fake)
      return cb(new ServerCompromisedError('Server sent fake transaction proposal'));

    var result;
    if (opts.forAirGapped) {
      result = {
        txps: JSON.parse(JSON.stringify(txps)),
        encryptedPkr: WalletUtils.encryptMessage(JSON.stringify(self.credentials.publicKeyRing), self.credentials.personalEncryptingKey),
        m: self.credentials.m,
        n: self.credentials.n,
      };
    } else {
      result = txps;
    }

    return cb(null, result);
  });
};

/**
 * Sign a transaction proposal
 *
 * @param {Object} txp
 * @param {Callback} cb
 * @return {Callback} cb - Return error or object
 */
API.prototype.signTxProposal = function(txp, cb) {
  $.checkState(this.credentials && this.credentials.isComplete());
  $.checkArgument(txp.creatorId);

  var self = this;

  if (!self.canSign() && !txp.signatures)
    return cb(new Error('You do not have the required keys to sign transactions'));

  if (!Verifier.checkTxProposal(self.credentials, txp)) {
    return cb(new ServerCompromisedError('Server sent fake transaction proposal'));
  }

  var signatures = txp.signatures || WalletUtils.signTxp(txp, self.credentials.xPrivKey);

  var url = '/v1/txproposals/' + txp.id + '/signatures/';
  var args = {
    signatures: signatures
  };

  self._doPostRequest(url, args, function(err, txp) {
    if (err) return cb(err);
    return cb(null, txp);
  });
};

/**
 * Sign transaction proposal from AirGapped
 *
 * @param {Object} txp
 * @param {String} encryptedPkr
 * @param {Number} m
 * @param {Number} n
 * @return {Object} txp - Return transaction
 */
API.prototype.signTxProposalFromAirGapped = function(txp, encryptedPkr, m, n) {
  $.checkState(this.credentials);

  var self = this;

  if (!self.canSign())
    throw new Error('You do not have the required keys to sign transactions');

  var publicKeyRing;
  try {
    publicKeyRing = JSON.parse(WalletUtils.decryptMessage(encryptedPkr, self.credentials.personalEncryptingKey));
  } catch (ex) {
    throw new Error('Could not decrypt public key ring');
  }

  if (!_.isArray(publicKeyRing) || publicKeyRing.length != n) {
    throw new Error('Invalid public key ring');
  }

  self.credentials.m = m;
  self.credentials.n = n;
  self.credentials.addPublicKeyRing(publicKeyRing);

  if (!Verifier.checkTxProposal(self.credentials, txp)) {
    throw new Error('Fake transaction proposal');
  }
  return WalletUtils.signTxp(txp, self.credentials.xPrivKey);
};


/**
 * Reject a transaction proposal
 *
 * @param {Object} txp
 * @param {String} reason
 * @param {Callback} cb
 * @return {Callback} cb - Return error or object
 */
API.prototype.rejectTxProposal = function(txp, reason, cb) {
  $.checkState(this.credentials && this.credentials.isComplete());
  $.checkArgument(cb);

  var self = this;

  var url = '/v1/txproposals/' + txp.id + '/rejections/';
  var args = {
    reason: API._encryptMessage(reason, self.credentials.sharedEncryptingKey) || '',
  };
  self._doPostRequest(url, args, function(err, txp) {
    if (err) return cb(err);
    return cb(null, txp);
  });
};

/**
 * Broadcast a transaction proposal
 *
 * @param {Object} txp
 * @param {Callback} cb
 * @return {Callback} cb - Return error or object
 */
API.prototype.broadcastTxProposal = function(txp, cb) {
  $.checkState(this.credentials && this.credentials.isComplete());

  var self = this;

  var url = '/v1/txproposals/' + txp.id + '/broadcast/';
  self._doPostRequest(url, {}, function(err, txp) {
    if (err) return cb(err);
    return cb(null, txp);
  });
};

/**
 * Remove a transaction proposal
 *
 * @param {Object} txp
 * @param {Callback} cb
 * @return {Callback} cb - Return error or empty
 */
API.prototype.removeTxProposal = function(txp, cb) {
  $.checkState(this.credentials && this.credentials.isComplete());

  var self = this;

  var url = '/v1/txproposals/' + txp.id;
  self._doDeleteRequest(url, function(err) {
    if (err) return cb(err);
    return cb();
  });
};

/**
 * Get transaction history
 *
 * @param {Object} opts
 * @param {Number} opts.minTs (defaults to 0)
 * @param {Number} opts.maxTs (defaults to now)
 * @param {Number} opts.limit
 * @param {Callback} cb
 * @return {Callback} cb - Return error or array of transactions
 */
API.prototype.getTxHistory = function(opts, cb) {
  $.checkState(this.credentials && this.credentials.isComplete());

  var self = this;
  var args = [];
  if (opts) {
    if (opts.minTs) args.push('minTs=' + opts.minTs);
    if (opts.maxTs) args.push('maxTs=' + opts.maxTs);
    if (opts.limit) args.push('limit=' + opts.limit);
  }
  var qs = '';
  if (args.length > 0) {
    qs = '?' + args.join('&');
  }

  var url = '/v1/txhistory/' + qs;
  self._doGetRequest(url, function(err, txs) {
    if (err) return cb(err);

    API._processTxps(txs, self.credentials.sharedEncryptingKey);

    return cb(null, txs);
  });
};

module.exports = API;
