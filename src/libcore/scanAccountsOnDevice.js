// @flow

import { Observable } from "rxjs";
import Transport from "@ledgerhq/hw-transport";
import { log } from "@ledgerhq/logs";
import { TransportStatusError } from "@ledgerhq/errors";
import { getCryptoCurrencyById } from "../currencies";
import {
  getDerivationModesForCurrency,
  isUnsplitDerivationMode,
  getPurposeDerivationMode,
  derivationModeSupportsIndex,
  isIterableDerivationMode,
  getMandatoryEmptyAccountSkip
} from "../derivation";
import {
  getWalletName,
  shouldShowNewAccount,
  isAccountEmpty
} from "../account";
import type { Account, CryptoCurrency, DerivationMode } from "../types";
import { withDevice } from "../hw/deviceAccess";
import getAddress from "../hw/getAddress";
import { withLibcoreF } from "./access";
import { syncCoreAccount } from "./syncAccount";
import { getOrCreateWallet } from "./getOrCreateWallet";
import { createAccountFromDevice } from "./createAccountFromDevice";
import { remapLibcoreErrors } from "./errors";
import type { Core, CoreWallet } from "./types";

async function scanNextAccount(props: {
  core: Core,
  transport: Transport<*>,
  currency: CryptoCurrency,
  accountIndex: number,
  onAccountScanned: Account => *,
  seedIdentifier: string,
  derivationMode: DerivationMode,
  showNewAccount: boolean,
  isUnsubscribed: () => boolean,
  emptyCount?: number
}) {
  const {
    core,
    transport,
    currency,
    accountIndex,
    onAccountScanned,
    seedIdentifier,
    derivationMode,
    showNewAccount,
    isUnsubscribed
  } = props;

  let coreAccount;

  try {
    coreAccount = await getAccount(accountIndex);
  } catch (err) {
    if (isUnsubscribed()) return;
    coreAccount = await createAccountFromDevice({
      core,
      transport,
      currency,
      index: accountIndex,
      derivationMode,
      isUnsubscribed
    });
  }

  if (isUnsubscribed() || !coreAccount) return;

  const account = await syncCoreAccount({
    core,
    currency,
    accountIndex,
    derivationMode,
    seedIdentifier
  });

  if (isUnsubscribed()) return;

  const isEmpty = isAccountEmpty(account);
  const shouldSkip =
    (isEmpty && !showNewAccount) ||
    !derivationModeSupportsIndex(derivationMode, accountIndex);

  log(
    "libcore",
    `scanning ${currency.id} ${derivationMode ||
      "default"}@${accountIndex}: resulted of ${
      account && !shouldSkip
        ? `Account with ${account.operations.length} txs (xpub ${String(
            account.xpub
          )}, fresh ${account.freshAddressPath} ${account.freshAddress})`
        : "no account"
    }. ${isEmpty ? "ALL SCANNED" : ""}`
  );

  if (!shouldSkip) {
    onAccountScanned(account);
  }

  const emptyCount = props.emptyCount || 0;
  const shouldIter = isEmpty
    ? emptyCount < getMandatoryEmptyAccountSkip(derivationMode)
    : isIterableDerivationMode(derivationMode);

  if (shouldIter) {
    await scanNextAccount({
      ...props,
      accountIndex: accountIndex + 1,
      emptyCount: isEmpty ? emptyCount + 1 : 0
    });
  }
}

export const scanAccountsOnDevice = (
  currency: CryptoCurrency,
  deviceId: string,
  filterDerivationMode?: DerivationMode => boolean
): Observable<Account> =>
  withDevice(deviceId)(transport =>
    Observable.create(o => {
      let finished = false;
      const unsubscribe = () => {
        finished = true;
      };
      const isUnsubscribed = () => finished;

      const main = withLibcoreF(core => async () => {
        try {
          let derivationModes = getDerivationModesForCurrency(currency);
          if (filterDerivationMode) {
            derivationModes = derivationModes.filter(filterDerivationMode);
          }
          for (let i = 0; i < derivationModes.length; i++) {
            const derivationMode = derivationModes[i];

            const unsplitFork = isUnsplitDerivationMode(derivationMode)
              ? currency.forkedFrom
              : null;
            const purpose = getPurposeDerivationMode(derivationMode);
            const { coinType } = unsplitFork
              ? getCryptoCurrencyById(unsplitFork)
              : currency;
            const path = `${purpose}'/${coinType}'`;

            let result;

            try {
              result = await getAddress(transport, {
                currency,
                path,
                derivationMode
              });
            } catch (e) {
              // feature detection: some old app will specifically returns this code for segwit case and we ignore it
              if (
                derivationMode === "segwit" &&
                e instanceof TransportStatusError &&
                e.statusCode === 0x6f04
              ) {
                log(
                  "libcore",
                  "scanAccountsOnDevice ignore segwit paths because app don't support"
                );
              } else {
                throw e;
              }
            }

            if (!result) continue;

            const seedIdentifier = result.publicKey;

            if (isUnsubscribed()) return;

            const onAccountScanned = account => o.next(account);

            // recursively scan all accounts on device on the given app
            // new accounts will be created in sqlite, existing ones will be updated
            await scanNextAccount({
              core,
              transport,
              currency,
              accountIndex: 0,
              onAccountScanned,
              seedIdentifier,
              derivationMode,
              showNewAccount: shouldShowNewAccount(currency, derivationMode),
              isUnsubscribed
            });
          }
          o.complete();
        } catch (e) {
          o.error(remapLibcoreErrors(e));
        }

        if (transport) {
          await transport.close();
        }
      });

      main();

      return unsubscribe;
    })
  );
