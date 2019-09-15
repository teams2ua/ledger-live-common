// @flow

import { Observable, from, defer } from "rxjs";
import { map } from "rxjs/operators";
import { SyncError } from "@ledgerhq/errors";
import type { Account, CryptoCurrency, DerivationMode } from "../types";
import { withLibcore } from "./access";
import { buildAccount } from "./buildAccount";
import { remapLibcoreErrors } from "./errors";
import { getKeychainEngine } from "../derivation";
import postSyncPatchPerFamily from "../generated/libcore-postSyncPatch";
var core_messages = require('./messages/commands_pb.js');
var bitcoin_messages = require('./messages/bitcoin/commands_pb.js');

// FIXME how to get that
const OperationOrderKey = {
  date: 0
};

export async function syncCoreAccount({
  core,
  currency,
  accountIndex,
  derivationMode,
  xpub,
  existingAccount
}: {
  core: *,
  currency: CryptoCurrency,
  accountIndex: number,
  derivationMode: DerivationMode,
  xpub: string,
  existingAccount?: ?Account
}): Promise<Account> {
  let coreOperations;
  let accId;
  try {
    accId = new bitcoin_messages.AccountID();
    accId.setCurrencyName(currency.name);
    accId.setXpub(xpub);
    const keychainEngine = getKeychainEngine(derivationMode);
    if (keychainEngine === "BIP49_P2SH") {
      accId.setKeychainEngine(bitcoin_messages.KeychainEngine.BIP49_P2SH);
    }
    else if (keychainEngine === "BIP32_P2PKH") {
      accId.setKeychainEngine(bitcoin_messages.KeychainEngine.BIP32_P2PKH);
    }
    else if (keychainEngine === "BIP173_P2WPKH") {
      accId.setKeychainEngine(bitcoin_messages.KeychainEngine.BIP173_P2WPKH);
    }
    else if (keychainEngine === "BIP173_P2WSH") {
      accId.setKeychainEngine(bitcoin_messages.KeychainEngine.BIP173_P2WSH);
    }
    //sync
    var syncReq = new bitcoin_messages.SyncAccountRequest();
    syncReq.setAccountId(accId)
    var bitcoinRequest = new bitcoin_messages.BitcoinRequest();
    bitcoinRequest.setSyncAccount(syncReq);
    var req = new core_messages.CoreRequest();
    req.setRequestType(core_messages.CoreRequestType.BITCOIN_REQUEST);
    req.setRequestBody(bitcoinRequest.serializeBinary());
    
    var resp = core_messages.CoreResponse.deserializeBinary(await core.sendRequest(req.serializeBinary()));
    if (resp.getError()) throw resp.getError();
    //get operations
    var getOps = new bitcoin_messages.GetOperationsRequest();
    getOps.setAccountId(accId)
    bitcoinRequest = new bitcoin_messages.BitcoinRequest();
    bitcoinRequest.setGetOperations(getOps);
    var req = new core_messages.CoreRequest();
    req.setRequestType(core_messages.CoreRequestType.BITCOIN_REQUEST);
    req.setRequestBody(bitcoinRequest.serializeBinary());
    
    resp = core_messages.CoreResponse.deserializeBinary(await core.sendRequest(req.serializeBinary()));
    if (resp.getError()) throw resp.getError();
    
    var getOperationsResponse = bitcoin_messages.GetOperationsResponse.deserializeBinary(resp.getResponseBody());
    coreOperations = getOperationsResponse.getOperationsList();
  } catch (e) {
    if (e.name !== "Error") throw remapLibcoreErrors(e);
    throw new SyncError(e.message);
  }

  const account = await buildAccount({
    core,
    coreAccountId: accId,
    coreOperations,
    currency,
    accountIndex,
    derivationMode,
    seedIdentifier,
    existingAccount
  });

  return account;
}

const defaultPostSyncPatch = (initial: Account, synced: Account): Account =>
  synced;

export function syncAccount(
  existingAccount: Account
): Observable<(Account) => Account> {
  const { derivationMode, seedIdentifier, currency } = existingAccount;
  const postSyncPatch =
    postSyncPatchPerFamily[currency.family] || defaultPostSyncPatch;
  return defer(() =>
    from(
      withLibcore(core =>
        syncCoreAccount({
          core,
          currency,
          accountIndex: existingAccount.index,
          derivationMode,
          seedIdentifier,
          existingAccount
        })
      )
    )
  ).pipe(
    map(syncedAccount => initialAccount =>
      postSyncPatch(initialAccount, {
        ...initialAccount,
        id: syncedAccount.id,
        freshAddress: syncedAccount.freshAddress,
        freshAddressPath: syncedAccount.freshAddressPath,
        balance: syncedAccount.balance,
        blockHeight: syncedAccount.blockHeight,
        lastSyncDate: new Date(),
        operations: syncedAccount.operations,
        tokenAccounts: syncedAccount.tokenAccounts,
        pendingOperations: []
      })
    )
  );
}
