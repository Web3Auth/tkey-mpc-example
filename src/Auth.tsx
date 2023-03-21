/* eslint-disable @typescript-eslint/no-loop-func */
/* eslint-disable @typescript-eslint/no-use-before-define */
import { getPubKeyECC, getPubKeyPoint, Point, ShareStore } from "@tkey/common-types";
import { TorusServiceProvider } from "@tkey/service-provider-torus";
import { LOGIN, LoginWindowResponse, TorusVerifierResponse } from "@toruslabs/customauth";
import { generatePrivate } from "@toruslabs/eccrypto";
import { ecCurve, encrypt, randomSelection } from "@toruslabs/rss-client";
import { generateAddressFromPrivKey } from "@toruslabs/torus.js";
import BN from "bn.js";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import swal from "sweetalert";
import Web3 from "web3";

import { setupWeb3 } from "./signing";
import { tKey } from "./tkey";
import { DELIMITERS, FactorKeyCloudMetadata, fetchPostboxKeyAndSigs, getEcCrypto, getTSSPubKey, uiConsole, wcVerifier } from "./utils";

const ec = getEcCrypto();

async function doMockLogin() {
  uiConsole("Mock login");
  const verifier = "torus-test-health";
  const verifierId = localStorage.getItem("mockVerifierId");
  const { signatures, postboxkey } = await fetchPostboxKeyAndSigs({ verifierName: verifier, verifierId });
  tKey.serviceProvider.postboxKey = new BN(postboxkey, "hex");
  (tKey.serviceProvider as TorusServiceProvider).verifierName = verifier;
  (tKey.serviceProvider as TorusServiceProvider).verifierId = verifierId;
  const loginResponse: any = {
    userInfo: { name: verifierId, email: "", verifierId, verifier, profileImage: "", typeOfLogin: LOGIN.JWT, accessToken: "", state: {} },
    signatures,
    privateKey: postboxkey,
    publicAddress: generateAddressFromPrivKey(ecCurve, new BN(postboxkey, "hex")),
    metadataNonce: "",
  };
  uiConsole("This is the login response:", loginResponse);
  return loginResponse;
}

const fetchDeviceShareFromTkey = async () => {
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
  } catch (err: unknown) {
    uiConsole(err);
    throw err;
  }
};

const isMetadataPresent = async (privateKeyBN: BN) => {
  const metadata = await tKey.storageLayer.getMetadata({ privKey: privateKeyBN });
  if (metadata && Object.keys(metadata).length > 0 && (metadata as any).message !== "KEY_NOT_FOUND") {
    return true;
  }
  return false;
};

const addFactorKeyMetadata = async (factorKey: BN, tssShare: BN, tssIndex: number, factorKeyDescription: string) => {
  if (!tKey) {
    console.error("tKey not initialized yet");
    return;
  }
  const { requiredShares } = tKey.getKeyDetails();
  if (requiredShares > 0) {
    console.error("not enough shares for metadata key");
  }

  const metadataDeviceShare = await fetchDeviceShareFromTkey();

  const factorIndex = getPubKeyECC(factorKey).toString("hex");
  const metadataToSet: FactorKeyCloudMetadata = {
    deviceShare: metadataDeviceShare as ShareStore,
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
    tssShareIndex: tssIndex,
  };
  await tKey.addShareDescription(factorIndex, JSON.stringify(params), true);
};

function Auth() {
  const location = useLocation();
  const navigate = useNavigate();

  const [user, setUser] = useState<TorusVerifierResponse & LoginWindowResponse>(null);
  const [loginResponse, setLoginResponse] = useState<any>(null);
  const [oAuthShare, setOAuthShare] = useState<BN>();
  const [compressedTSSPubKey, setCompressedTSSPubKey] = useState<Buffer>(null);
  const [web3AuthSigs, setWeb3AuthSigs] = useState<string[]>([]);
  const [f2Share, setf2Share] = useState<BN>(null);
  const [f2Index, setf2Index] = useState<number>(null);
  const [sessionId, setSessionID] = useState<string>("");
  const [localFactorKey, setLocalFactorKey] = useState<BN>(null);
  const [web3, setWeb3] = useState<Web3>(null);

  // Updates factor key
  useEffect(() => {
    if (!localFactorKey) return;
    localStorage.setItem(
      `tKeyLocalStore\u001c${loginResponse.userInfo.verifier}\u001c${loginResponse.userInfo.verifierId}`,
      JSON.stringify({
        factorKey: localFactorKey.toString("hex"),
        verifier: loginResponse.userInfo.verifier,
        verifierId: loginResponse.userInfo.verifierId,
      })
    );
  }, [localFactorKey]);

  // Gets the OAuth response
  useEffect(() => {
    async function getKeys() {
      const params = new URLSearchParams(location.hash.slice(1));
      const loginType = params.get("type");
      let currentLoginResponse: any;
      if (loginType === "mock") {
        currentLoginResponse = await doMockLogin();
      } else if (loginType === "webauthn") {
        const loginHint = params.get("login_hint");
        const idToken = params.get("id_token");
        const response = await (tKey.serviceProvider as TorusServiceProvider).directWeb.getTorusKey(
          wcVerifier,
          loginHint,
          { verifier_id: loginHint },
          idToken
        );
        currentLoginResponse = {
          userInfo: {
            name: loginHint,
            email: loginHint,
            verifierId: loginHint,
            verifier: wcVerifier,
            profileImage: "",
            typeOfLogin: LOGIN.JWT,
            accessToken: "",
            state: {},
            idToken,
          },
          signatures: response.signatures,
          privateKey: response.privateKey,
          publicAddress: response.publicAddress,
          metadataNonce: "",
        };
      } else {
        const response = await (tKey.serviceProvider as TorusServiceProvider).directWeb.getRedirectResult();
        if (response.result) {
          currentLoginResponse = response.result as any;
        } else {
          console.error("Invalid login response", response);
        }
        uiConsole("This is the login response:", currentLoginResponse);
      }
      if (currentLoginResponse) {
        setUser(currentLoginResponse.userInfo);
        setLoginResponse(currentLoginResponse);
        tKey.serviceProvider.postboxKey = new BN(currentLoginResponse.privateKey, "hex");
        (tKey.serviceProvider as TorusServiceProvider).verifierName = currentLoginResponse.userInfo.verifier;
        (tKey.serviceProvider as TorusServiceProvider).verifierId = currentLoginResponse.userInfo.verifierId;
      }
    }

    uiConsole("current hash", location.hash);
    if (location.hash) getKeys();
    else {
      navigate({ pathname: "/" });
    }
  }, []);

  // Initialize TKey
  useEffect(() => {
    async function initializeTKey() {
      try {
        setOAuthShare(new BN(loginResponse.privateKey, 16));

        const signatures = loginResponse.signatures.filter((sign) => sign !== null);
        const { verifierId } = loginResponse.userInfo;

        const tKeyLocalStoreString = localStorage.getItem(
          `tKeyLocalStore\u001c${loginResponse.userInfo.verifier}\u001c${loginResponse.userInfo.verifierId}`
        );
        const tKeyLocalStore = JSON.parse(tKeyLocalStoreString || "{}");

        let factorKey: BN | null = null;

        const existingUser = await isMetadataPresent(loginResponse.privateKey);

        if (!existingUser) {
          factorKey = new BN(generatePrivate());
          const deviceTSSShare = new BN(generatePrivate());
          const deviceTSSIndex = 2;
          const factorPub = getPubKeyPoint(factorKey);
          await tKey.initialize({ useTSS: true, factorPub, deviceTSSShare, deviceTSSIndex });
        } else {
          if (tKeyLocalStore.verifier === loginResponse.userInfo.verifier && tKeyLocalStore.verifierId === loginResponse.userInfo.verifierId) {
            factorKey = new BN(tKeyLocalStore.factorKey, "hex");
          } else {
            try {
              factorKey = await swal("Enter your backup share", {
                content: "input" as any,
              }).then(async (value) => {
                uiConsole(value);
                return (tKey.modules.shareSerialization as any).deserialize(value, "mnemonic");
              });
            } catch (error) {
              uiConsole(error);
              throw new Error("Invalid backup share");
            }
          }
          if (factorKey === null) throw new Error("Backup share not found");
          const factorKeyMetadata = await tKey.storageLayer.getMetadata<{
            message: string;
          }>({
            privKey: factorKey,
          });
          if (factorKeyMetadata.message === "KEY_NOT_FOUND") {
            throw new Error("no metadata for your factor key, reset your account");
          }
          const metadataShare = JSON.parse(factorKeyMetadata.message);
          if (!metadataShare.deviceShare || !metadataShare.tssShare) throw new Error("Invalid data from metadata");
          const metadataDeviceShare = metadataShare.deviceShare;
          await tKey.initialize({ neverInitializeNewKey: true });
          await tKey.inputShareStoreSafe(metadataDeviceShare, true);
          await tKey.reconstructKey();
        }

        // Checks the requiredShares to reconstruct the tKey,
        // starts from 2 by default and each of the above share reduce it by one.
        const { requiredShares } = tKey.getKeyDetails();
        if (requiredShares > 0) {
          throw new Error(`Threshold not met. Required Share: ${requiredShares}. You should reset your account.`);
        }
        // 2. Reconstruct the Metadata Key
        const metadataKey = await tKey.reconstructKey();

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
        const vid = `${loginResponse.userInfo.verifier}${DELIMITERS.Delimiter1}${verifierId}`;

        // 5. save factor key and other metadata
        if (
          !existingUser ||
          !(tKeyLocalStore.verifier === loginResponse.userInfo.verifier && tKeyLocalStore.verifierId === loginResponse.userInfo.verifierId)
        ) {
          await addFactorKeyMetadata(factorKey, factor2Share, factor2Index, "local storage key");
        }
        await tKey.syncLocalMetadataTransitions();
        setLocalFactorKey(factorKey);
        setSessionID(`${vid}${DELIMITERS.Delimiter2}default${DELIMITERS.Delimiter3}${tssNonce}${DELIMITERS.Delimiter4}`);
        setf2Share(factor2Share);
        setf2Index(factor2Index);
        setCompressedTSSPubKey(compressedTSSPubKey);
        setWeb3AuthSigs(signatures);

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
      } catch (e) {
        console.error(e);
        uiConsole(`Error in initializing TKey ${e}`);
      }
    }
    if (loginResponse) initializeTKey();
  }, [loginResponse]);

  // sets up web3
  useEffect(() => {
    const localSetup = async () => {
      const web3Local = await setupWeb3(sessionId, f2Index, f2Share, web3AuthSigs, compressedTSSPubKey);
      setWeb3(web3Local);
    };
    if (compressedTSSPubKey && web3AuthSigs.length > 0) {
      localSetup();
    }
  }, [compressedTSSPubKey, web3AuthSigs]);

  const copyTSSShareIntoManualBackupFactorkey = async () => {
    try {
      if (!tKey) {
        throw new Error("tkey does not exist, cannot add factor pub");
      }
      if (!localFactorKey) {
        throw new Error("localFactorKey does not exist, cannot add factor pub");
      }

      const backupFactorKey = new BN(generatePrivate());
      const backupFactorPub = getPubKeyPoint(backupFactorKey);
      // const backupFactorIndex = Object.keys(tKey.getMetadata().getShareDescription()).length;
      // uiConsole("TSSIndex:", backupFactorIndex + 1);
      await copyExistingTSSShareForNewFactor(backupFactorPub, localFactorKey);

      const { tssShare: tssShare2, tssIndex: tssIndex2 } = await tKey.getTSSShare(localFactorKey);
      await addFactorKeyMetadata(backupFactorKey, tssShare2, tssIndex2, "manual share");
      const serializedShare = await (tKey.modules.shareSerialization as any).serialize(backupFactorKey, "mnemonic");
      await tKey.syncLocalMetadataTransitions();
      uiConsole("Successfully created manual backup. Manual Backup Factor: ", serializedShare);
    } catch (err) {
      uiConsole(`Failed to create new manual factor ${err}`);
    }
  };

  const createNewTSSShareIntoManualBackupFactorkey = async () => {
    try {
      if (!tKey) {
        throw new Error("tkey does not exist, cannot add factor pub");
      }
      if (!localFactorKey) {
        throw new Error("localFactorKey does not exist, cannot add factor pub");
      }

      const backupFactorKey = new BN(generatePrivate());
      const backupFactorPub = getPubKeyPoint(backupFactorKey);
      const tKeyShareDescriptions = await tKey.getMetadata().getShareDescription();
      let backupFactorIndex = 2;
      for (const [key, value] of Object.entries(tKeyShareDescriptions)) {
        // eslint-disable-next-line no-loop-func, array-callback-return
        value.map((factor: any) => {
          factor = JSON.parse(factor);
          if (factor.tssShareIndex > backupFactorIndex) {
            backupFactorIndex = factor.tssShareIndex;
          }
        });
      }
      uiConsole("backupFactorIndex:", backupFactorIndex + 1);
      await addNewTSSShareAndFactor(backupFactorPub, backupFactorIndex + 1, localFactorKey);

      const { tssShare: tssShare2, tssIndex: tssIndex2 } = await tKey.getTSSShare(backupFactorKey);
      await addFactorKeyMetadata(backupFactorKey, tssShare2, tssIndex2, "manual share");
      const serializedShare = await (tKey.modules.shareSerialization as any).serialize(backupFactorKey, "mnemonic");

      await tKey.syncLocalMetadataTransitions();
      uiConsole(" Successfully created manual backup.Manual Backup Factor: ", serializedShare);
    } catch (err) {
      uiConsole(`Failed to create new manual factor ${err}`);
    }
  };

  const addNewTSSShareAndFactor = async (newFactorPub: Point, newFactorTSSIndex: number, factorKeyForExistingTSSShare: BN) => {
    if (!tKey) {
      throw new Error("tkey does not exist, cannot add factor pub");
    }
    if (!(newFactorTSSIndex === 2 || newFactorTSSIndex === 3)) {
      throw new Error("tssIndex must be 2 or 3");
    }
    if (!tKey.metadata.factorPubs || !Array.isArray(tKey.metadata.factorPubs[tKey.tssTag])) {
      throw new Error("factorPubs does not exist");
    }
    const existingFactorPubs = tKey.metadata.factorPubs[tKey.tssTag].slice();
    const updatedFactorPubs = existingFactorPubs.concat([newFactorPub]);
    const existingTSSIndexes = existingFactorPubs.map((fb) => tKey.getFactorEncs(fb).tssIndex);
    const updatedTSSIndexes = existingTSSIndexes.concat([newFactorTSSIndex]);
    const { tssShare, tssIndex } = await tKey.getTSSShare(factorKeyForExistingTSSShare);

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
      authSignatures: web3AuthSigs,
    });
  };

  const copyExistingTSSShareForNewFactor = async (newFactorPub: Point, factorKeyForExistingTSSShare: BN) => {
    if (!tKey) {
      throw new Error("tkey does not exist, cannot copy factor pub");
    }
    if (!tKey.metadata.factorPubs || !Array.isArray(tKey.metadata.factorPubs[tKey.tssTag])) {
      throw new Error("factorPubs does not exist, failed in copy factor pub");
    }
    if (!tKey.metadata.factorEncs || typeof tKey.metadata.factorEncs[tKey.tssTag] !== "object") {
      throw new Error("factorEncs does not exist, failed in copy factor pub");
    }

    const existingFactorPubs = tKey.metadata.factorPubs[tKey.tssTag].slice();
    const updatedFactorPubs = existingFactorPubs.concat([newFactorPub]);
    const { tssShare, tssIndex } = await tKey.getTSSShare(factorKeyForExistingTSSShare);
    // use for sanity check if needed
    // if (tssIndex !== newFactorTSSIndex) {
    //   throw new Error("retrieved tssIndex does not match input factor tssIndex");
    // }
    const factorEncs = JSON.parse(JSON.stringify(tKey.metadata.factorEncs[tKey.tssTag]));
    const factorPubID = newFactorPub.x.toString(16, 64);
    factorEncs[factorPubID] = {
      tssIndex,
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

  const keyDetails = async () => {
    if (!tKey) {
      uiConsole("tKey not initialized yet");
      return;
    }
    // const keyDetails = await tKey.getKeyDetails();

    uiConsole("TSS Public Key: ", tKey.getTSSPub(), "With Factors/Shares:", tKey.getMetadata().getShareDescription());
    // return keyDetails;
  };

  const logout = (): void => {
    uiConsole("Log out");
    navigate({ pathname: "/" });
  };

  const getUserInfo = (): void => {
    uiConsole(user);
  };

  const getMetadataKey = async (): Promise<void> => {
    const metadataKey = await tKey.reconstructKey();
    uiConsole(metadataKey.privKey.toString("hex"));
  };

  const getLoginResponse = (): void => {
    uiConsole(loginResponse);
    return loginResponse;
  };

  const resetAccount = async () => {
    try {
      localStorage.removeItem(`tKeyLocalStore\u001c${loginResponse.userInfo.verifier}\u001c${loginResponse.userInfo.verifierId}`);
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
    if (!web3) {
      uiConsole("provider not initialized yet");
      return;
    }
    const chainId = await web3.eth.getChainId();
    uiConsole(chainId);
    return chainId;
  };

  const getAccounts = async () => {
    if (!web3) {
      uiConsole("provider not initialized yet");
      return;
    }
    const address = (await web3.eth.getAccounts())[0];
    uiConsole(address);
    return address;
  };

  const getBalance = async () => {
    if (!web3) {
      uiConsole("provider not initialized yet");
      return;
    }
    const address = (await web3.eth.getAccounts())[0];
    const balance = web3.utils.fromWei(
      await web3.eth.getBalance(address) // Balance is in wei
    );
    uiConsole(balance);
    return balance;
  };

  const deleteTkeyLocalStore = async () => {
    localStorage.removeItem(`tKeyLocalStore\u001c${loginResponse.userInfo.verifier}\u001c${loginResponse.userInfo.verifierId}`);
    uiConsole("Successfully deleted tKey local store");
  };

  const signMessage = async (): Promise<any> => {
    if (!web3) {
      uiConsole("provider not initialized yet");
      return;
    }
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
    if (!web3) {
      uiConsole("provider not initialized yet");
      return;
    }
    const fromAddress = (await web3.eth.getAccounts())[0];

    const amount = web3.utils.toWei("0.0001"); // Convert 1 ether to wei

    // Submit transaction to the blockchain and wait for it to be mined
    const receipt = await web3.eth.sendTransaction({
      from: fromAddress,
      to: fromAddress,
      value: amount,
    });
    uiConsole(receipt);
  };

  return (
    <div className="container">
      <h1 className="title">
        <a target="_blank" href="http://web3auth.io/" rel="noreferrer">
          Web3Auth (tKey)
        </a>
        & ReactJS Ethereum Example
      </h1>

      <h2 className="subtitle">Account Details</h2>
      <div className="flex-container">
        <button onClick={getUserInfo} className="card">
          Get User Info
        </button>

        <button onClick={getLoginResponse} className="card">
          See Login Response
        </button>

        <button onClick={keyDetails} className="card">
          Key Details
        </button>

        <button onClick={getMetadataKey} className="card">
          Metadata Key
        </button>

        <button onClick={logout} className="card">
          Log Out
        </button>
      </div>
      <h2 className="subtitle">Recovery/ Key Manipulation</h2>
      <div className="flex-container">
        <button onClick={copyTSSShareIntoManualBackupFactorkey} className="card">
          Copy Existing TSS Share For New Factor Manual
        </button>

        <button onClick={createNewTSSShareIntoManualBackupFactorkey} className="card">
          Create New TSSShare Into Manual Backup Factor
        </button>

        <button onClick={deleteTkeyLocalStore} className="card">
          Delete tKey Local Store (enables Recovery Flow)
        </button>

        <button onClick={resetAccount} className="card">
          Reset Account (CAUTION)
        </button>
      </div>
      <h2 className="subtitle">Blockchain Calls</h2>
      <div className="flex-container">
        <button onClick={getChainID} className="card">
          Get Chain ID
        </button>

        <button onClick={getAccounts} className="card">
          Get Accounts
        </button>

        <button onClick={getBalance} className="card">
          Get Balance
        </button>

        <button onClick={signMessage} className="card">
          Sign Message
        </button>

        <button onClick={sendTransaction} className="card">
          Send Transaction
        </button>
      </div>

      <div id="console" style={{ whiteSpace: "pre-line" }}>
        <p style={{ whiteSpace: "pre-line" }}></p>
      </div>

      <footer className="footer">
        <a href="https://github.com/Web3Auth/examples/tree/main/tkey/tkey-react-example" target="_blank" rel="noopener noreferrer">
          Source code
        </a>
      </footer>
    </div>
  );
}

export default Auth;
