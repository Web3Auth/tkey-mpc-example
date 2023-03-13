/* eslint-disable require-atomic-updates */
/* eslint-disable @typescript-eslint/no-shadow */
/* eslint-disable no-console */
/* eslint-disable no-throw-literal */
import "./App.css";

import { getPubKeyECC, getPubKeyPoint, Point, ShareStore } from "@tkey/common-types";
import { TorusServiceProvider } from "@tkey/service-provider-torus";
import { LOGIN, LoginWindowResponse, TorusVerifierResponse } from "@toruslabs/customauth";
import { generatePrivate } from "@toruslabs/eccrypto";
import { encrypt, randomSelection } from "@toruslabs/rss-client";
import { Client } from "@toruslabs/tss-client";
import * as tss from "@toruslabs/tss-lib";
import type { SafeEventEmitterProvider } from "@web3auth-mpc/base";
import { EthereumSigningProvider } from "@web3auth-mpc/ethereum-provider";
import BN from "bn.js";
import keccak256 from "keccak256";
import { useEffect, useState } from "react";
import Web3 from "web3";
import type { provider } from "web3-core";

import { tKey } from "./tkey";
import { createSockets, fetchPostboxKeyAndSigs, getDKLSCoeff, getEcCrypto, getTSSPubKey } from "./utils";
const chainId = "0x5";

const ec = getEcCrypto();

const parties = 4;
const clientIndex = parties - 1;

const DELIMITERS = {
  Delimiter1: "\u001c",
  Delimiter2: "\u0015",
  Delimiter3: "\u0016",
  Delimiter4: "\u0017",
};

type FactorKeyCloudMetadata = {
  deviceShare: ShareStore;
  tssShare: BN;
  tssIndex: number;
};

const tssImportUrl = `https://sapphire-dev-2-2.authnetwork.dev/tss/v1/clientWasm`;

const uiConsole = (...args: any[]): void => {
  const el = document.querySelector("#console>p");
  if (el) {
    el.innerHTML = JSON.stringify(args || {}, null, 2);
  }
  console.log(...args);
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

const generateTSSEndpoints = (parties: number, clientIndex: number) => {
  const endpoints: string[] = [];
  const tssWSEndpoints: string[] = [];
  const partyIndexes: number[] = [];
  for (let i = 0; i < parties; i++) {
    partyIndexes.push(i);
    if (i === clientIndex) {
      endpoints.push(null as any);
      tssWSEndpoints.push(null as any);
    } else {
      endpoints.push(`https://sapphire-dev-2-${i + 1}.authnetwork.dev/tss`);
      tssWSEndpoints.push(`https://sapphire-dev-2-${i + 1}.authnetwork.dev`);
    }
  }
  return { endpoints, tssWSEndpoints, partyIndexes };
};

function App() {
  const [user, setUser] = useState<TorusVerifierResponse & LoginWindowResponse>(null);
  const [email, setEmail] = useState("");
  const [metadataKey, setMetadataKey] = useState<string>("");
  const [provider, setProvider] = useState<SafeEventEmitterProvider>();
  const [compressedTSSPubKey, setCompressedTSSPubKey] = useState<Buffer>(null);
  const [web3AuthSigs, setWeb3AuthSigs] = useState<string>(null);
  const [f2Share, setf2Share] = useState<BN>(null);
  const [f2Index, setf2Index] = useState<number>(null);
  const [sessionId, setSessionID] = useState<string>("");
  const [localFactorKey, setLocalFactorKey] = useState<BN>(null);
  const [oAuthShare, setOAuthShare] = useState<BN>(null);

  // Init Service Provider inside the useEffect Method

  useEffect(() => {
    if (!localFactorKey) return;
    localStorage.setItem("tKeyLocalStore", localFactorKey.toString("hex"));
  }, [localFactorKey]);

  useEffect(() => {
    const init = async () => {
      // Initialization of Service Provider
      try {
        await (tKey.serviceProvider as any).init();
      } catch (error) {
        console.error(error);
      }
    };
    init();
  }, []);
  useEffect(() => {
    const ethProvider = async () => {
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
            throw `sessionAuth does not exist ${currentSession}`;
          }
          if (!web3AuthSigs) {
            throw `Signature does not exist ${web3AuthSigs}`;
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
          throw `compressedTSSPubKey does not exist ${compressedTSSPubKey}`;
        }

        const getPublic: () => Promise<Buffer> = async () => {
          return compressedTSSPubKey;
        };

        await ethereumSigningProvider.setupProvider({ sign, getPublic });
        console.log(ethereumSigningProvider.provider);
        setProvider(ethereumSigningProvider.provider);
      } catch (e) {
        console.error(e);
      }
    };
    if (compressedTSSPubKey && web3AuthSigs.length > 0) ethProvider();
  }, [compressedTSSPubKey, web3AuthSigs]);

  const triggerLogin = async () => {
    if (!tKey) {
      uiConsole("tKey not initialized yet");
      return;
    }
    try {
      // Triggering Login using Service Provider ==> opens the popup
      const loginResponse = await (tKey.serviceProvider as TorusServiceProvider).triggerLogin({
        typeOfLogin: "jwt",
        verifier: "mpc-key-demo-passwordless",
        jwtParams: {
          domain: "https://wc-auth.web3auth.com",
          // verifierIdField: "name",
          connection: "email",
          login_hint: email,
        },
        clientId: "QQRQNGxJ80AZ5odiIjt1qqfryPOeDcb1",
      });
      uiConsole("This is the login response:", loginResponse);
      setUser(loginResponse.userInfo);
      return loginResponse;
      // uiConsole('Public Key : ' + loginResponse.publicAddress);
      // uiConsole('Email : ' + loginResponse.userInfo.email);
    } catch (error) {
      uiConsole(error);
    }
  };

  const triggerMockLogin = async () => {
    if (!tKey) {
      uiConsole("tKey not initialized yet");
      return;
    }
    try {
      const verifier = "torus-test-health";
      const verifierId = "test809@example.com";
      const { signatures, postboxkey } = await fetchPostboxKeyAndSigs({ verifierName: verifier, verifierId });
      tKey.serviceProvider.postboxKey = new BN(postboxkey, "hex");
      (tKey.serviceProvider as TorusServiceProvider).verifierName = verifier;
      (tKey.serviceProvider as TorusServiceProvider).verifierId = verifierId;
      const loginResponse = {
        userInfo: { name: verifierId, email: "", verifierId, verifier, profileImage: "", typeOfLogin: LOGIN.JWT, accessToken: "", state: {} },
        signatures,
        privateKey: postboxkey,
      };
      uiConsole("This is the login response:", loginResponse);
      setUser(loginResponse.userInfo);
      return loginResponse;
      // uiConsole('Public Key : ' + loginResponse.publicAddress);
      // uiConsole('Email : ' + loginResponse.userInfo.email);
    } catch (error) {
      uiConsole(error);
    }
  };

  const initializeNewKey = async (mockLogin: boolean) => {
    if (!tKey) {
      uiConsole("tKey not initialized yet");
      return;
    }
    try {
      let loginResponse, verifier;
      if (mockLogin) {
        loginResponse = await triggerMockLogin();
        verifier = "torus-test-health";
      } else {
        loginResponse = await triggerLogin(); // Calls the triggerLogin() function above
        verifier = "mpc-key-demo-passwordless";
      }
      setOAuthShare(loginResponse.privateKey);

      const signatures = loginResponse.signatures.filter((sign) => sign !== null);
      const verifierId = loginResponse.userInfo.name;

      const localFactorKey: string = localStorage.getItem("tKeyLocalStore");

      // Right not we're depending on if local storage exists to tell us if
      // user is new or existing. TODO: change to depend on intiialize, then rehydrate
      let factorKey: BN;
      let deviceTSSShare: BN;
      let deviceTSSIndex: number;
      let existingUser = false;
      let metadataDeviceShare: ShareStore;
      if (!localFactorKey) {
        factorKey = new BN(generatePrivate());
        deviceTSSShare = new BN(generatePrivate());
        deviceTSSIndex = 2;
      } else {
        factorKey = new BN(localFactorKey, "hex");
        const factorKeyMetadata = await tKey.storageLayer.getMetadata<{
          message: string;
        }>({
          privKey: factorKey,
        });
        if (factorKeyMetadata.message === "KEY_NOT_FOUND") {
          throw new Error("no metadata for your factor key, reset your account");
        }
        const metadataShare: FactorKeyCloudMetadata = JSON.parse(factorKeyMetadata.message);

        if (!metadataShare.deviceShare || !metadataShare.tssShare) throw new Error("Invalid data from metadata");
        metadataDeviceShare = metadataShare.deviceShare;
        existingUser = true;
      }

      const factorPub = getPubKeyPoint(factorKey);
      // Initialization of tKey
      if (existingUser) {
        await tKey.initialize({ neverInitializeNewKey: true });
        await tKey.inputShareStoreSafe(metadataDeviceShare, true);
        await tKey.reconstructKey();
      } else {
        await tKey.initialize({ useTSS: true, factorPub, deviceTSSShare, deviceTSSIndex });
      }

      // Checks the requiredShares to reconstruct the tKey,
      // starts from 2 by default and each of the above share reduce it by one.
      const { requiredShares } = tKey.getKeyDetails();
      if (requiredShares > 0) {
        throw `Threshold not met. Required Share: ${requiredShares}. You should reset your account.`;
      }
      // 2. Reconstruct the Metadata Key
      const metadataKey = await tKey.reconstructKey();
      setMetadataKey(metadataKey?.privKey.toString("hex"));

      const tssNonce = tKey.metadata.tssNonces[tKey.tssTag];
      const factor1PubKeyDetails = await tKey.serviceProvider.getTSSPubKey(tKey.tssTag, tssNonce);
      const factor1PubKey = { x: factor1PubKeyDetails.x.toString("hex"), y: factor1PubKeyDetails.y.toString("hex") };

      const { tssShare: factor2Share, tssIndex: factor2Index } = await tKey.getTSSShare(factorKey);

      // 3. get user's tss share from tkey.
      const factor2ECPK = ec.curve.g.mul(factor2Share);
      const factor2PubKey = { x: factor2ECPK.getX().toString("hex"), y: factor2ECPK.getY().toString("hex") };

      // 4. derive tss pub key, tss pubkey is implicitly formed using the dkgPubKey and the userShare (as well as userTSSIndex)
      const tssPubKey = getTSSPubKey(factor1PubKey, factor2PubKey, factor2Index);
      const compressedTSSPubKey = Buffer.from(`${tssPubKey.getX().toString(16, 64)}${tssPubKey.getY().toString(16, 64)}`, "hex");
      const vid = `${verifier}${DELIMITERS.Delimiter1}${verifierId}`;

      // 5. save factor key and other metadata
      await addFactorKeyMetadata(factorKey, factor2Share, factor2Index, "local storage key");
      await tKey.syncLocalMetadataTransitions();
      setLocalFactorKey(factorKey);
      setSessionID(`${vid}${DELIMITERS.Delimiter2}default${DELIMITERS.Delimiter3}${tssNonce}${DELIMITERS.Delimiter4}`);
      setf2Share(factor2Share);
      setf2Index(factor2Index);
      setCompressedTSSPubKey(compressedTSSPubKey);
      setWeb3AuthSigs(signatures);
      console.log("PRINTS HERE");
      console.log(factor2Share);
      console.log(factor2Index);
      console.log(compressedTSSPubKey);
      console.log(signatures);

      uiConsole(
        "Successfully logged in & initialised MPC TKey SDK",
        "TSS Public Key: ",
        tssPubKey,
        "Factor 1 Public Key",
        factor1PubKey,
        "Factor 2 Public Key",
        factor2PubKey,
        "Metadata Key",
        metadataKey.privKey.toString("hex")
      );
    } catch (error) {
      uiConsole(error, "caught");
    }
  };

  const fetchDeviceShareFromTkey = async () => {
    if (!tKey) {
      uiConsole("tKey not initialized yet");
      return;
    }
    try {
      const polyId = tKey.metadata.getLatestPublicPolynomial().getPolynomialID();
      const shares = tKey.shares[polyId];
      let deviceShare: ShareStore;

      for (const shareIndex in shares) {
        if (shareIndex !== "1") {
          deviceShare = shares[shareIndex];
        }
      }
      return deviceShare;
    } catch (err: any) {
      uiConsole({ err });
      throw new Error(err);
    }
  };

  const addFactorKeyMetadata = async (factorKey: BN, tssShare: BN, tssIndex: number, factorKeyDescription: string) => {
    if (!tKey) {
      uiConsole("tKey not initialized yet");
      return;
    }
    const { requiredShares } = tKey.getKeyDetails();
    if (requiredShares > 0) {
      uiConsole("not enough shares for metadata key");
    }

    const metadataDeviceShare = await fetchDeviceShareFromTkey();

    const factorIndex = getPubKeyECC(factorKey).toString("hex");
    const metadataToSet: FactorKeyCloudMetadata = {
      deviceShare: metadataDeviceShare,
      tssShare,
      tssIndex,
    };

    // Set metadata for factor key backup
    await tKey.addLocalMetadataTransitions({
      input: [{ message: JSON.stringify(metadataToSet) }],
      privKey: [factorKey],
    });

    // also set a description on tkey
    const params = {
      module: factorKeyDescription,
      dateAdded: Date.now(),
    };
    await tKey.addShareDescription(factorIndex, JSON.stringify(params), true);
  };

  const keyDetails = async () => {
    if (!tKey) {
      uiConsole("tKey not initialized yet");
      return;
    }
    const keyDetails = await tKey.getKeyDetails();
    uiConsole(keyDetails);
    return keyDetails;
  };

  const logout = (): void => {
    uiConsole("Log out");
    setUser(null);
  };

  const getUserInfo = (): void => {
    uiConsole(user);
  };

  const getMetadataKey = (): void => {
    uiConsole(metadataKey);
  };

  const addNewTSSShareAndFactor = async (newFactorPub: Point, newFactorTSSIndex: number, inputFactorKey: BN) => {
    if (!tKey) {
      throw new Error("tkey does not exist, cannot add factor pub");
    }
    if (newFactorTSSIndex !== 2 && newFactorTSSIndex !== 3) {
      throw new Error("tssIndex must be 2 or 3");
    }
    if (!tKey.metadata.factorPubs || !Array.isArray(tKey.metadata.factorPubs[tKey.tssTag])) {
      throw new Error("factorPubs does not exist");
    }
    const existingFactorPubs = tKey.metadata.factorPubs[tKey.tssTag].slice();
    const updatedFactorPubs = existingFactorPubs.concat([newFactorPub]);
    const existingTSSIndexes = existingFactorPubs.map((fb) => tKey.getFactorEncs(fb).tssIndex);
    const updatedTSSIndexes = existingTSSIndexes.concat([newFactorTSSIndex]);
    const { tssShare, tssIndex } = await tKey.getTSSShare(inputFactorKey);
    tKey.metadata.addTSSData({
      tssTag: tKey.tssTag,
      factorPubs: updatedFactorPubs,
    });
    const rssNodeDetails = await tKey._getRssNodeDetails();
    const { serverEndpoints, serverPubKeys, serverThreshold } = rssNodeDetails;
    const randomSelectedServers = randomSelection(
      new Array(rssNodeDetails.serverEndpoints.length).fill(null).map((_, i) => i + 1),
      Math.ceil(rssNodeDetails.serverEndpoints.length / 2)
    );
    const verifierNameVerifierId = tKey.serviceProvider.getVerifierNameVerifierId();
    await tKey._refreshTSSShares(true, tssShare, tssIndex, updatedFactorPubs, updatedTSSIndexes, verifierNameVerifierId, {
      selectedServers: randomSelectedServers,
      serverEndpoints,
      serverPubKeys,
      serverThreshold,
      authSignatures: await this.getSignatures(),
    });
  };

  const copyExistingTSSShareForNewFactor = async (newFactorPub: Point, newFactorTSSIndex: number, inputFactorKey: BN) => {
    if (!tKey) {
      throw new Error("tkey does not exist, cannot copy factor pub");
    }
    if (newFactorTSSIndex !== 2 && newFactorTSSIndex !== 3) {
      throw new Error("input factor tssIndex must be 2 or 3");
    }
    if (!tKey.metadata.factorPubs || !Array.isArray(tKey.metadata.factorPubs[tKey.tssTag])) {
      throw new Error("factorPubs does not exist, failed in copy factor pub");
    }
    if (!tKey.metadata.factorEncs || typeof tKey.metadata.factorEncs[tKey.tssTag] !== "object") {
      throw new Error("factorEncs does not exist, failed in copy factor pub");
    }
    const existingFactorPubs = tKey.metadata.factorPubs[tKey.tssTag].slice();
    const updatedFactorPubs = existingFactorPubs.concat([newFactorPub]);
    const { tssShare, tssIndex } = await tKey.getTSSShare(inputFactorKey);
    if (tssIndex !== newFactorTSSIndex) {
      throw new Error("retrieved tssIndex does not match input factor tssIndex");
    }
    const factorEncs = JSON.parse(JSON.stringify(tKey.metadata.factorEncs[tKey.tssTag]));
    const factorPubID = newFactorPub.x.toString(16, 64);
    factorEncs[factorPubID] = {
      tssIndex: newFactorTSSIndex,
      type: "direct",
      userEnc: await encrypt(
        Buffer.concat([
          Buffer.from("04", "hex"),
          Buffer.from(newFactorPub.x.toString(16, 64), "hex"),
          Buffer.from(newFactorPub.y.toString(16, 64), "hex"),
        ]),
        Buffer.from(tssShare.toString(16, 64), "hex")
      ),
      serverEncs: [],
    };
    tKey.metadata.addTSSData({
      tssTag: tKey.tssTag,
      factorPubs: updatedFactorPubs,
      factorEncs,
    });
  };

  const resetAccount = async () => {
    try {
      localStorage.removeItem("tKeyLocalStore");
      await tKey.storageLayer.setMetadata({
        privKey: oAuthShare,
        input: { message: "KEY_NOT_FOUND" },
      });
      uiConsole("Reset Account Successful.");
    } catch (e) {
      uiConsole(e);
    }
  };

  const getChainID = async () => {
    if (!provider) {
      console.log("provider not initialized yet");
      return;
    }
    const web3 = new Web3(provider as provider);
    const chainId = await web3.eth.getChainId();
    uiConsole(chainId);
    return chainId;
  };

  const getAccounts = async () => {
    if (!provider) {
      console.log("provider not initialized yet");
      return;
    }
    const web3 = new Web3(provider as provider);
    const address = (await web3.eth.getAccounts())[0];
    uiConsole(address);
    return address;
  };

  const getBalance = async () => {
    if (!provider) {
      console.log("provider not initialized yet");
      return;
    }
    const web3 = new Web3(provider as provider);
    const address = (await web3.eth.getAccounts())[0];
    const balance = web3.utils.fromWei(
      await web3.eth.getBalance(address) // Balance is in wei
    );
    uiConsole(balance);
    return balance;
  };

  const signMessage = async (): Promise<any> => {
    if (!provider) {
      console.log("provider not initialized yet");
      return;
    }
    const web3 = new Web3(provider as provider);
    const fromAddress = (await web3.eth.getAccounts())[0];
    const originalMessage = [
      {
        type: "string",
        name: "fullName",
        value: "Satoshi Nakamoto",
      },
      {
        type: "uint32",
        name: "userId",
        value: "1212",
      },
    ];
    const params = [originalMessage, fromAddress];
    const method = "eth_signTypedData";
    const signedMessage = await (web3.currentProvider as any)?.sendAsync({
      id: 1,
      method,
      params,
      fromAddress,
    });
    uiConsole(signedMessage);
  };

  const sendTransaction = async () => {
    if (!provider) {
      console.log("provider not initialized yet");
      return;
    }
    const web3 = new Web3(provider as provider);
    const fromAddress = (await web3.eth.getAccounts())[0];

    const destination = "0x7aFac68875d2841dc16F1730Fba43974060b907A";
    const amount = web3.utils.toWei("0.0001"); // Convert 1 ether to wei

    // Submit transaction to the blockchain and wait for it to be mined
    const receipt = await web3.eth.sendTransaction({
      from: fromAddress,
      to: destination,
      value: amount,
    });
    uiConsole(receipt);
  };

  const loggedInView = (
    <>
      <div className="flex-container">
        <div>
          <button onClick={getUserInfo} className="card">
            Get User Info
          </button>
        </div>
        <div>
          <button onClick={keyDetails} className="card">
            Key Details
          </button>
        </div>
        <div>
          <button onClick={getMetadataKey} className="card">
            Metadata Key
          </button>
        </div>
        <div>
          <button onClick={resetAccount} className="card">
            Reset Account
          </button>
        </div>
        <div>
          <button onClick={getChainID} className="card">
            Get Chain ID
          </button>
        </div>
        <div>
          <button onClick={getAccounts} className="card">
            Get Accounts
          </button>
        </div>
        <div>
          <button onClick={getBalance} className="card">
            Get Balance
          </button>
        </div>

        <div>
          <button onClick={signMessage} className="card">
            Sign Message
          </button>
        </div>
        <div>
          <button onClick={sendTransaction} className="card">
            Send Transaction
          </button>
        </div>
        {/* <div>
          <button onClick={addNewTSSShareAndFactor} className="card">
            addNewTSSShareAndFactor
          </button>
        </div>
        <div>
          <button onClick={copyExistingTSSShareForNewFactor} className="card">
            copyExistingTSSShareForNewFactor
          </button>
        </div> */}
        <div>
          <button onClick={logout} className="card">
            Log Out
          </button>
        </div>
      </div>

      <div id="console" style={{ whiteSpace: "pre-line" }}>
        <p style={{ whiteSpace: "pre-line" }}></p>
      </div>
    </>
  );

  const unloggedInView = (
    <div>
      <span>Enter your email: </span>
      <input type="email" onChange={(e) => setEmail(e.target.value)} />
      <button onClick={() => initializeNewKey(false)} className="card">
        Login
      </button>
      <button onClick={() => initializeNewKey(true)} className="card">
        MockLogin
      </button>
    </div>
  );

  return (
    <div className="container">
      <h1 className="title">
        <a target="_blank" href="http://web3auth.io/" rel="noreferrer">
          Web3Auth (tKey)
        </a>
        & ReactJS Ethereum Example
      </h1>

      <div className="grid">{user ? loggedInView : unloggedInView}</div>

      <footer className="footer">
        <a href="https://github.com/Web3Auth/examples/tree/main/tkey/tkey-react-example" target="_blank" rel="noopener noreferrer">
          Source code
        </a>
      </footer>
    </div>
  );
}

export default App;
