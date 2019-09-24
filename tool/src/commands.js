// @flow
/* eslint-disable global-require */

import {
  from,
  defer,
  of,
  concat,
  empty,
  Observable,
  interval,
  throwError
} from "rxjs";
import {
  map,
  reduce,
  mergeMap,
  ignoreElements,
  concatMap,
  shareReplay,
  tap,
  scan as rxScan,
  catchError
} from "rxjs/operators";
import fs from "fs";
import qrcode from "qrcode-terminal";
import { dataToFrames } from "qrloop/exporter";
import { getEnv } from "@ledgerhq/live-common/lib/env";
import { isValidRecipient } from "@ledgerhq/live-common/lib/libcore/isValidRecipient";
import signAndBroadcast from "@ledgerhq/live-common/lib/libcore/signAndBroadcast";
import { getFeesForTransaction } from "@ledgerhq/live-common/lib/libcore/getFeesForTransaction";
import { getFees } from "@ledgerhq/live-common/lib/libcore/getFees";
import { formatCurrencyUnit } from "@ledgerhq/live-common/lib/currencies";
import { encode } from "@ledgerhq/live-common/lib/cross";
import manager from "@ledgerhq/live-common/lib/manager";
import { asDerivationMode } from "@ledgerhq/live-common/lib/derivation";
import { withLibcore } from "@ledgerhq/live-common/lib/libcore/access";
import { withDevice } from "@ledgerhq/live-common/lib/hw/deviceAccess";
import getVersion from "@ledgerhq/live-common/lib/hw/getVersion";
import getDeviceInfo from "@ledgerhq/live-common/lib/hw/getDeviceInfo";
import getAppAndVersion from "@ledgerhq/live-common/lib/hw/getAppAndVersion";
import genuineCheck from "@ledgerhq/live-common/lib/hw/genuineCheck";
import openApp from "@ledgerhq/live-common/lib/hw/openApp";
import quitApp from "@ledgerhq/live-common/lib/hw/quitApp";
import installApp from "@ledgerhq/live-common/lib/hw/installApp";
import uninstallApp from "@ledgerhq/live-common/lib/hw/uninstallApp";
import prepareFirmwareUpdate from "@ledgerhq/live-common/lib/hw/firmwareUpdate-prepare";
import mainFirmwareUpdate from "@ledgerhq/live-common/lib/hw/firmwareUpdate-main";
import repairFirmwareUpdate from "@ledgerhq/live-common/lib/hw/firmwareUpdate-repair";
import getAddress from "@ledgerhq/live-common/lib/hw/getAddress";
import signMessage from "@ledgerhq/live-common/lib/hw/signMessage";
import { discoverDevices } from "@ledgerhq/live-common/lib/hw";
import accountFormatters from "./accountFormatters";
import proxy from "./proxy";
var messages = require("@ledgerhq/live-common/src/libcore/messages/commands_pb");
import {
  scan,
  scanCommonOpts,
  currencyOpt,
  deviceOpt,
  inferCurrency,
  inferManagerApp
} from "./scan";
import { inferTransactions, inferTransactionsOpts } from "./transaction";
import { apdusFromFile } from "./stream";
import { toAccountRaw } from "@ledgerhq/live-common/lib/account/serialization";
import { Buffer } from "buffer";

const getFeesFormatters = {
  raw: e => e,
  json: e => ({
    type: e.type,
    value: Array.isArray(e.value)
      ? e.value.map(bn => bn.toNumber())
      : e.value.toNumber()
  }),
  summary: e => {
    switch (e.type) {
      case "feePerBytes":
        return "feePerBytes: " + e.value.map(bn => bn.toString());
      case "gasPrice":
        return (
          "gasPrice: " + formatCurrencyUnit(e.unit, e.value, { showCode: true })
        );
      case "fee":
        return (
          "fee: " + formatCurrencyUnit(e.unit, e.value, { showCode: true })
        );
      default:
        return e;
    }
  }
};

const asQR = str =>
  Observable.create(o =>
    qrcode.generate(str, r => {
      o.next(r);
      o.complete();
    })
  );

const all = {
  version: {
    args: [],
    job: () =>
      concat(
        of("ledger-live cli: " + require("../package.json").version),
        of(
          "@ledgerhq/live-common: " +
            require("@ledgerhq/live-common/package.json").version
        ),
        of(
          "@ledgerhq/ledger-core: " +
            require("@ledgerhq/ledger-core/package.json").version
        ),
        from(withLibcore(async core => {
          var getVersionRequest = new messages.CoreRequest();
          getVersionRequest.setRequestType(messages.CoreRequestType.GET_VERSION);
          var getVersionResponse = messages.CoreResponse.deserializeBinary(await core.sendRequest(getVersionRequest.serializeBinary()));
          var versionResp = messages.GetVersionResponse.deserializeBinary(getVersionResponse.getResponseBody());
          return versionResp.getMajor() + "." + versionResp.getMinor() + "." + versionResp.getPatch();
        })).pipe(
          map(v => "libcore: " + v)
        )
      )
  },

  libcoreReset: {
    args: [],
    job: () =>
      withLibcore(async core => {
        await core.getPoolInstance().freshResetAll();
      })
  },

  libcoreSetPassword: {
    args: [{ name: "password", type: String, desc: "the new password" }],
    job: ({ password }) =>
      withLibcore(core =>
        core
          .getPoolInstance()
          .changePassword(getEnv("LIBCORE_PASSWORD"), password || "")
      )
  },

  proxy,

  discoverDevices: {
    args: [
      {
        name: "module",
        alias: "m",
        type: String,
        desc: "filter a specific module (either hid | ble)"
      },
      {
        name: "interactive",
        alias: "i",
        type: Boolean,
        desc:
          "interactive mode that accumulate the events instead of showing them"
      }
    ],
    job: ({ module, interactive }) => {
      const events = discoverDevices(m =>
        !module ? true : module.split(",").includes(m.id)
      );
      if (!interactive) return events;
      return events
        .pipe(
          rxScan((acc, value) => {
            let copy;
            if (value.type === "remove") {
              copy = acc.filter(a => a.id === value.id);
            } else {
              const existing = acc.find(o => o.id === value.id);
              if (existing) {
                const i = acc.indexOf(existing);
                copy = [...acc];
                if (value.name) {
                  copy[i] = value;
                }
              } else {
                copy = acc.concat({ id: value.id, name: value.name });
              }
            }
            return copy;
          }, [])
        )
        .pipe(
          tap(() => {
            // eslint-disable-next-line no-console
            console.clear();
          }),
          map(acc =>
            acc
              .map(o => `${(o.name || "(no name)").padEnd(40)} ${o.id}`)
              .join("\n")
          )
        );
    }
  },

  deviceVersion: {
    args: [deviceOpt],
    job: ({ device }) => withDevice(device || "")(t => from(getVersion(t)))
  },

  deviceAppVersion: {
    args: [deviceOpt],
    job: ({ device }) =>
      withDevice(device || "")(t => from(getAppAndVersion(t)))
  },

  deviceInfo: {
    args: [deviceOpt],
    job: ({ device }) => withDevice(device || "")(t => from(getDeviceInfo(t)))
  },

  repl: {
    description: "Low level exchange with the device. Send APDUs from stdin.",
    args: [
      deviceOpt,
      {
        name: "file",
        alias: "f",
        type: String,
        typeDesc: "filename",
        desc: "A file can also be provided. By default stdin is used."
      }
    ],
    job: ({ device, file }) =>
      withDevice(device || "")(t =>
        apdusFromFile(file || "-").pipe(concatMap(apdu => t.exchange(apdu)))
      ).pipe(map(res => res.toString("hex")))
  },

  liveData: {
    description: "utility for Ledger Live app.json file",
    args: [
      ...scanCommonOpts,
      {
        name: "appjson",
        type: String,
        typeDesc: "filename",
        desc: "path to a live desktop app.json"
      },
      {
        name: "add",
        alias: "a",
        type: Boolean,
        desc: "add accounts to live data"
      }
    ],
    job: opts =>
      scan(opts).pipe(
        reduce((accounts, account) => accounts.concat(account), []),
        mergeMap(accounts => {
          const appjsondata = opts.appjson
            ? JSON.parse(fs.readFileSync(opts.appjson, "utf-8"))
            : { data: { accounts: [] } };
          if (typeof appjsondata.data.accounts === "string") {
            return throwError(
              new Error("encrypted ledger live data is not supported")
            );
          }
          const existingIds = appjsondata.data.accounts.map(a => a.data.id);
          const append = accounts
            .filter(a => !existingIds.includes(a.id))
            .map(account => ({
              data: toAccountRaw(account),
              version: 1
            }));
          appjsondata.data.accounts = appjsondata.data.accounts.concat(append);
          if (opts.appjson) {
            fs.writeFileSync(
              opts.appjson,
              JSON.stringify(appjsondata),
              "utf-8"
            );
            return of(append.length + " accounts added.");
          } else {
            return of(JSON.stringify(appjsondata));
          }
        })
      )
  },

  exportAccounts: {
    description: "Export given accounts to Live QR or console for importing",
    args: [
      ...scanCommonOpts,
      {
        name: "out",
        alias: "o",
        type: Boolean,
        desc: "output to console"
      }
    ],
    job: opts =>
      scan(opts).pipe(
        reduce((accounts, account) => accounts.concat(account), []),
        mergeMap(accounts => {
          const data = encode({
            accounts,
            settings: { currenciesSettings: {} },
            exporterName: "ledger-live-cli",
            exporterVersion: "0.0.0"
          });
          const frames = dataToFrames(data, 80, 4);

          if (opts.out) {
            return of(Buffer.from(JSON.stringify(frames)).toString("base64"));
          } else {
            const qrObservables = frames.map(str =>
              asQR(str).pipe(shareReplay())
            );
            return interval(300).pipe(
              mergeMap(i => qrObservables[i % qrObservables.length])
            );
          }
        }),
        tap(() => console.clear()) // eslint-disable-line no-console
      )
  },

  genuineCheck: {
    description: "Perform a genuine check with Ledger's HSM",
    args: [deviceOpt],
    job: ({ device }) =>
      withDevice(device || "")(t =>
        from(getDeviceInfo(t)).pipe(
          mergeMap(deviceInfo => genuineCheck(t, deviceInfo))
        )
      )
  },

  firmwareUpdate: {
    description: "Perform a firmware update",
    args: [deviceOpt],
    job: ({ device }) =>
      withDevice(device || "")(t => from(getDeviceInfo(t))).pipe(
        mergeMap(manager.getLatestFirmwareForDevice),
        mergeMap(firmware => {
          if (!firmware) return of("already up to date");
          return concat(
            of(
              `firmware: ${firmware.final.name}\nOSU: ${firmware.osu.name} (hash: ${firmware.osu.hash})`
            ),
            prepareFirmwareUpdate("", firmware),
            mainFirmwareUpdate("", firmware)
          );
        })
      )
  },

  firmwareRepair: {
    description: "Repair a firmware update",
    args: [
      deviceOpt,
      {
        name: "forceMCU",
        type: String,
        desc: "force a mcu version to install"
      }
    ],
    job: ({ device, forceMCU }) => repairFirmwareUpdate(device || "", forceMCU)
  },

  managerListApps: {
    description: "List apps that can be installed on the device",
    args: [
      deviceOpt,
      {
        name: "format",
        alias: "f",
        type: String,
        typeDesc: "raw | json | default"
      }
    ],
    job: ({ device, format }) =>
      withDevice(device || "")(t =>
        from(getDeviceInfo(t)).pipe(
          mergeMap(deviceInfo => from(manager.getAppsList(deviceInfo, true))),
          map(list =>
            format === "raw"
              ? list
              : format === "json"
              ? JSON.stringify(list)
              : list.map(item => `- ${item.name} ${item.version}`).join("\n")
          )
        )
      )
  },

  app: {
    description: "Manage Ledger device's apps",
    args: [
      deviceOpt,
      {
        name: "verbose",
        alias: "v",
        type: Boolean,
        desc: "enable verbose logs"
      },
      {
        name: "install",
        alias: "i",
        type: String,
        desc: "install an application by its name",
        multiple: true
      },
      {
        name: "uninstall",
        alias: "u",
        type: String,
        desc: "uninstall an application by its name",
        multiple: true
      },
      {
        name: "open",
        alias: "o",
        type: String,
        desc: "open an application by its display name"
      },
      {
        name: "quit",
        alias: "q",
        type: Boolean,
        desc: "close current application"
      }
    ],
    job: ({ device, verbose, install, uninstall, open, quit }) =>
      withDevice(device || "")(t => {
        if (quit) return from(quitApp(t));
        if (open) return from(openApp(t, inferManagerApp(open)));

        return from(getDeviceInfo(t)).pipe(
          mergeMap(deviceInfo =>
            from(manager.getAppsList(deviceInfo, true)).pipe(
              mergeMap(list =>
                concat(
                  ...(uninstall || []).map(application => {
                    const { targetId } = deviceInfo;
                    const app = list.find(
                      item =>
                        item.name.toLowerCase() ===
                        inferManagerApp(application).toLowerCase()
                    );
                    if (!app) {
                      throw new Error(
                        "application '" + application + "' not found"
                      );
                    }
                    return uninstallApp(t, targetId, app);
                  }),
                  ...(install || []).map(application => {
                    const { targetId } = deviceInfo;
                    const app = list.find(
                      item =>
                        item.name.toLowerCase() ===
                        inferManagerApp(application).toLowerCase()
                    );
                    if (!app) {
                      throw new Error(
                        "application '" + application + "' not found"
                      );
                    }
                    return installApp(t, targetId, app);
                  })
                )
              )
            )
          ),
          verbose ? map(a => a) : ignoreElements()
        );
      })
  },

  validRecipient: {
    description: "Validate a recipient address",
    args: [
      {
        name: "recipient",
        alias: "r",
        type: String,
        desc: "the address to validate"
      },
      currencyOpt,
      deviceOpt
    ],
    job: arg =>
      inferCurrency(arg)
        .toPromise()
        .then(currency =>
          isValidRecipient({
            currency,
            recipient: arg.recipient
          })
        )
        .then(
          warning =>
            warning ? { type: "warning", warning } : { type: "success" },
          error => ({ type: "error", error: error.message })
        )
  },

  signMessage: {
    description: "Sign a message with the device on specific derivations (advanced)",
    args: [
      currencyOpt,
      { name: "path", type: String, desc: "HDD derivation path" },
      { name: "derivationMode", type: String, desc: "derivationMode to use" },
      { name: "message", type: String, desc: "the message to sign" },
    ],
    job: arg => inferCurrency(arg).pipe(
      mergeMap(currency => {
        if (!currency) {
          throw new Error("no currency provided");
        }
        if (!arg.path) {
          throw new Error("--path is required");
        }
        asDerivationMode(arg.derivationMode);
        return withDevice(arg.device || "")(t =>
          from(
            signMessage(t, {
              ...arg,
              currency
            })
          )
        );
      })
    )
  },

  getAddress: {
    description:
      "Get an address with the device on specific derivations (advanced)",
    args: [
      currencyOpt,
      { name: "path", type: String, desc: "HDD derivation path" },
      { name: "derivationMode", type: String, desc: "derivationMode to use" },
      {
        name: "verify",
        alias: "v",
        type: Boolean,
        desc: "also ask verification on device"
      }
    ],
    job: arg =>
      inferCurrency(arg).pipe(
        mergeMap(currency => {
          if (!currency) {
            throw new Error("no currency provided");
          }
          if (!arg.path) {
            throw new Error("--path is required");
          }
          asDerivationMode(arg.derivationMode);
          return withDevice(arg.device || "")(t =>
            from(
              getAddress(t, {
                ...arg,
                currency
              })
            )
          );
        })
      )
  },

  feesForTransaction: {
    description: "Calculate how much fees a given transaction is going to cost",
    args: [...scanCommonOpts, ...inferTransactionsOpts],
    job: opts =>
      scan(opts).pipe(
        concatMap((account: Account) =>
          from(inferTransactions(account, opts)).pipe(
            mergeMap(inferred =>
              inferred.reduce(
                (acc, t) =>
                  concat(
                    acc,
                    from(
                      defer(() =>
                        getFeesForTransaction({
                          ...t,
                          account
                        })
                      )
                    )
                  ),
                empty()
              )
            ),
            map(n =>
              formatCurrencyUnit(account.unit, n, {
                showCode: true,
                disableRounding: true
              })
            )
          )
        )
      )
  },

  sync: {
    description: "Synchronize accounts with blockchain",
    args: [
      ...scanCommonOpts,
      {
        name: "format",
        alias: "f",
        type: String,
        typeDesc: Object.keys(accountFormatters).join(" | "),
        desc: "how to display the data"
      }
    ],
    job: opts =>
      scan(opts).pipe(
        map(account =>
          (accountFormatters[opts.format] || accountFormatters.default)(account)
        )
      )
  },

  getFees: {
    description: "Get the currency fees for accounts",
    args: [
      ...scanCommonOpts,
      {
        name: "format",
        alias: "f",
        type: String,
        typeDesc: Object.keys(getFeesFormatters).join(" | "),
        desc: "how to display the data"
      }
    ],
    job: opts =>
      scan(opts).pipe(
        mergeMap(account => from(getFees(account))),
        map(e => {
          const f = getFeesFormatters[opts.format || "summary"];
          if (!f)
            throw new Error("getFees: no such formatter '" + opts.format + "'");
          return f(e);
        })
      )
  },

  receive: {
    description: "Receive crypto-assets (verify on device)",
    args: [
      ...scanCommonOpts,
      {
        name: "qr",
        type: Boolean,
        desc: "also display a QR Code"
      }
    ],
    job: opts =>
      scan(opts).pipe(
        concatMap(account =>
          concat(
            of(account.freshAddress),
            opts.qr ? asQR(account.freshAddress) : empty(),
            withDevice(opts.device || "")(t =>
              from(
                getAddress(t, {
                  currency: account.currency,
                  derivationMode: account.derivationMode,
                  path: account.freshAddressPath,
                  verify: true
                })
              )
            ).pipe(ignoreElements())
          )
        )
      )
  },

  send: {
    description: "Send crypto-assets",
    args: [
      ...scanCommonOpts,
      ...inferTransactionsOpts,
      {
        name: "format",
        alias: "f",
        type: String,
        typeDesc: "default | json",
        desc: "how to display the data"
      },
      {
        name: "ignore-errors",
        type: Boolean,
        desc: "when using multiple transactions, an error won't stop the flow"
      }
    ],
    job: opts =>
      scan(opts).pipe(
        concatMap((account: Account) =>
          from(inferTransactions(account, opts)).pipe(
            mergeMap(inferred =>
              inferred.reduce(
                (acc, t) =>
                  concat(
                    acc,
                    from(
                      defer(() =>
                        signAndBroadcast({
                          ...t,
                          account,
                          deviceId: ""
                        }).pipe(
                          ...(opts["ignore-errors"]
                            ? [
                                catchError(e => {
                                  return of({
                                    type: "error",
                                    error: e,
                                    transaction: t
                                  });
                                })
                              ]
                            : [])
                        )
                      )
                    )
                  ),
                empty()
              )
            ),
            map(obj => (opts.format === "json" ? JSON.stringify(obj) : obj))
          )
        )
      )
  }
};

export default all;
