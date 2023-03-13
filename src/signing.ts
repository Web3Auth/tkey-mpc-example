import { generatePrivate } from "@toruslabs/eccrypto";
import { Client } from "@toruslabs/tss-client";
import * as tss from "@toruslabs/tss-lib";
import { EthereumSigningProvider } from "@web3auth-mpc/ethereum-provider";
import BN from "bn.js";
import keccak256 from "keccak256";
import Web3 from "web3";
import type { provider } from "web3-core";

import { createSockets, getDKLSCoeff, getEcCrypto } from "./utils";

const parties = 4;
const clientIndex = parties - 1;
const ec = getEcCrypto();

const tssImportUrl = `https://sapphire-dev-2-2.authnetwork.dev/tss/v1/clientWasm`;

const generateTSSEndpoints = (num: number, index: number) => {
  const endpoints: string[] = [];
  const tssWSEndpoints: string[] = [];
  const partyIndexes: number[] = [];
  for (let i = 0; i < num; i++) {
    partyIndexes.push(i);
    if (i === index) {
      endpoints.push(null);
      tssWSEndpoints.push(null);
    } else {
      endpoints.push(`https://sapphire-dev-2-${i + 1}.authnetwork.dev/tss`);
      tssWSEndpoints.push(`https://sapphire-dev-2-${i + 1}.authnetwork.dev`);
    }
  }
  return { endpoints, tssWSEndpoints, partyIndexes };
};

const setupSockets = async (tssWSEndpoints: string[]) => {
  const sockets = await createSockets(tssWSEndpoints);
  // wait for websockets to be connected
  await new Promise((resolve) => {
    const checkConnectionTimer = setInterval(() => {
      for (let i = 0; i < sockets.length; i++) {
        if (sockets[i] !== null && !sockets[i].connected) return;
      }
      clearInterval(checkConnectionTimer);
      resolve(true);
    }, 100);
  });

  return sockets;
};

export const setupWeb3 = async (sessionId: string, f2Index: number, f2Share: BN, web3AuthSigs: string[], compressedTSSPubKey: Buffer) => {
  try {
    const ethereumSigningProvider = new EthereumSigningProvider({
      config: {
        /*
                      pass the chain config that you want to connect with
                      all chainConfig fields are required.
                      */
        chainConfig: {
          chainId: "0x5",
          rpcTarget: "https://rpc.ankr.com/eth_goerli",
          displayName: "Goerli Testnet",
          blockExplorer: "https://goerli.etherscan.io",
          ticker: "ETH",
          tickerName: "Ethereum",
        },
      },
    });
    /*
              pass user's private key here.
              after calling setupProvider, we can use
              */
    const sign = async (msgHash: Buffer) => {
      // 1. setup
      // generate endpoints for servers
      const { endpoints, tssWSEndpoints, partyIndexes } = generateTSSEndpoints(parties, clientIndex);
      // setup mock shares, sockets and tss wasm files.
      const [sockets] = await Promise.all([setupSockets(tssWSEndpoints), tss.default(tssImportUrl)]);

      const randomSessionNonce = keccak256(generatePrivate().toString("hex") + Date.now());

      // session is needed for authentication to the web3auth infrastructure holding the factor 1
      const currentSession = `${sessionId}${randomSessionNonce.toString("hex")}`;

      const participatingServerDKGIndexes = [1, 2, 3];
      const dklsCoeff = getDKLSCoeff(true, participatingServerDKGIndexes, f2Index);
      const denormalisedShare = dklsCoeff.mul(f2Share).umod(ec.curve.n);
      const share = Buffer.from(denormalisedShare.toString(16, 64), "hex").toString("base64");

      if (!currentSession) {
        throw new Error(`sessionAuth does not exist ${currentSession}`);
      }
      if (!web3AuthSigs) {
        throw new Error(`Signature does not exist ${web3AuthSigs}`);
      }

      const client = new Client(
        currentSession,
        clientIndex,
        partyIndexes,
        endpoints,
        sockets,
        share,
        compressedTSSPubKey.toString("base64"),
        true,
        tssImportUrl
      );
      const serverCoeffs = {};
      for (let i = 0; i < participatingServerDKGIndexes.length; i++) {
        const serverIndex = participatingServerDKGIndexes[i];
        serverCoeffs[serverIndex] = getDKLSCoeff(false, participatingServerDKGIndexes, f2Index, serverIndex).toString("hex");
      }
      client.precompute(tss, { signatures: web3AuthSigs, server_coeffs: serverCoeffs });
      await client.ready();
      const { r, s, recoveryParam } = await client.sign(tss as any, Buffer.from(msgHash).toString("base64"), true, "", "keccak256", {
        signatures: web3AuthSigs,
      });
      await client.cleanup(tss, { signatures: web3AuthSigs, server_coeffs: serverCoeffs });
      return { v: recoveryParam, r: Buffer.from(r.toString("hex"), "hex"), s: Buffer.from(s.toString("hex"), "hex") };
    };

    if (!compressedTSSPubKey) {
      throw new Error(`compressedTSSPubKey does not exist ${compressedTSSPubKey}`);
    }

    const getPublic: () => Promise<Buffer> = async () => {
      return compressedTSSPubKey;
    };

    await ethereumSigningProvider.setupProvider({ sign, getPublic });
    console.log(ethereumSigningProvider.provider);
    const web3 = new Web3(ethereumSigningProvider.provider as provider);
    return web3;
  } catch (e) {
    console.error(e);
    return null;
  }
};
