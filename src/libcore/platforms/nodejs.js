// @flow
/* eslint-disable no-for-in */
/* eslint-disable no-params-reassign */
/* eslint-disable new-cap */

import invariant from "invariant";
import { log } from "@ledgerhq/logs";
import { NotEnoughBalance } from "@ledgerhq/errors/lib";
import { deserializeError, serializeError } from "@ledgerhq/errors/lib/helpers";
import { reflect } from "../types";
import type { Core, CoreStatics } from "../types";
import { setLoadCoreImplementation } from "../access";
import { setRemapLibcoreErrorsImplementation } from "../errors";
import { getEnv } from "../../env";
import {UbinderOnPromises} from "ubinder/src/js_common/UbinderOnPromises";
const commands = require('@ledgerhq/ledger-core/js/messages/commands_pb')
const core_config = require('@ledgerhq/ledger-core/js/messages/core_configuration_pb')
const services = require('@ledgerhq/ledger-core/js/messages/services_pb.js')


import network from "../../network";

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const axios = require('axios');

function OnRequest(data, callback) {
    var serviceReq = services.ServiceRequest.deserializeBinary(data);
    if (serviceReq.getType() == services.ServiceRequestType.HTTP_REQ) {
        var httpReq = services.HttpRequest.deserializeBinary(serviceReq.getRequestBody());
        const method = httpReq.getMethod();
        const headersMap = httpReq.getHeadersMap();
        let dataStr = httpReq.getBody();
        const headers = {};
        headersMap.forEach((v, k) => {
            headers[k] = v;
        });
        let res;
        const param = {
            method,
            headers
        };
        param.url = httpReq.getUrl();
        if (dataStr != "") {
            param.data = dataStr;
        }
        console.log(param);
        axios(param)
          .then((resp) => {
              var serviceResp = new services.ServiceResponse();
              var respMessage = new services.HttpResponse();
              respMessage.setCode(resp.status);
              respMessage.setBody(JSON.stringify(resp.data));
              serviceResp.setResponseBody(respMessage.serializeBinary());
              callback(serviceResp.serializeBinary());
              })
          .catch((err) => {
              console.log(err);
              var serviceResp = new services.ServiceResponse();
              serviceResp.setError(err.message);
              callback(serviceResp.serializeBinary());
          });
    }
}

function OnNotification(data) {

}

async function GetVersion(callbacker) {
    var req = new commands.CoreRequest();
    req.setRequestType(commands.CoreRequestType.GET_VERSION);
    
    var resp = commands.CoreResponse.deserializeBinary(await callbacker.sendRequest(req.serializeBinary()));
    if (resp.error) throw resp.error;
    var versionResp = commands.GetVersionResponse.deserializeBinary(resp.getResponseBody());
    const stringVersion = versionResp.getMajor() + "." + versionResp.getMinor() + "." + versionResp.getPatch();
    return stringVersion;
}

async function SetSettings(callbacker, dbPath, dbPassword) {
  var dbConfig = new core_config.DatabaseConfiguration();
  dbConfig.setPassword(dbPassword);
  dbConfig.setDbName("ledgerlive");
  var configuration = new core_config.LibCoreConfiguration();
  configuration.setWorkingDir(dbPath);
  configuration.setDatabaseConfig(dbConfig);
  var req = new commands.CoreRequest();
  req.setRequestType(commands.CoreRequestType.SET_CONFIGURATION);
  req.setRequestBody(configuration.serializeBinary());
  var resp = commands.CoreResponse.deserializeBinary(await callbacker.sendRequest(req.serializeBinary()));
  if (resp.getError()) throw resp.getError();
  return True;
}

export default (arg: {
  // the actual @ledgerhq/ledger-core lib or a function that returns it
  lib: any,
  dbPath: string,
  dbPassword?: string
}) => {
  let lib;
  const lazyLoad = () => {
    if (lib) return;
    if (typeof arg.lib === "function") {
      lib = arg.lib();
    } else {
      lib = arg.lib;
    }
  };
  const { dbPath } = arg;
  const dbPassword =
    typeof arg.dbPassword === "undefined"
      ? getEnv("LIBCORE_PASSWORD")
      : arg.dbPassword;

  const loadCore = async function() {
    lazyLoad();

    const MAX_RANDOM = 2684869021;

    var callbacker = new UbinderOnPromises(lib, OnNotification, OnRequest);
    try {
      fs.mkdirSync(dbPath);
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
    }
    await SetSettings(callbacker, dbPath, dbPassword);
    return callbacker;
  };

  const remapLibcoreErrors = (input: Error) => {
    lazyLoad();
    const e: mixed = input;
    if (e && typeof e === "object") {
      if (
        typeof e.code === "number" &&
        e.code === lib.ERROR_CODE.NOT_ENOUGH_FUNDS
      ) {
        return new NotEnoughBalance();
      }
    }
    return input;
  };

  setLoadCoreImplementation(loadCore);
  setRemapLibcoreErrorsImplementation(remapLibcoreErrors);
};
