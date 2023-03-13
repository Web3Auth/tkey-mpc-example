import { getPubKeyECC, getPubKeyPoint, ShareStore } from "@tkey/common-types";
import { TorusServiceProvider } from "@tkey/service-provider-torus";
import { LOGIN, LoginWindowResponse, TorusLoginResponse, TorusVerifierResponse } from "@toruslabs/customauth";
import { generatePrivate } from "@toruslabs/eccrypto";
import { ecCurve } from "@toruslabs/rss-client";
import { generateAddressFromPrivKey } from "@toruslabs/torus.js";
import BN from "bn.js";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Web3 from "web3";

import { setupWeb3 } from "./signing";
import { tKey } from "./tkey";
import { DELIMITERS, FactorKeyCloudMetadata, fetchPostboxKeyAndSigs, getEcCrypto, getTSSPubKey, uiConsole, wcVerifier } from "./utils";

const ec = getEcCrypto();

async function doMockLogin() {
  console.log("Mock login");
  const verifier = "torus-test-health";
  const verifierId = "test800@example.com";
  const { signatures, postboxkey } = await fetchPostboxKeyAndSigs({ verifierName: verifier, verifierId });
  tKey.serviceProvider.postboxKey = new BN(postboxkey, "hex");
  (tKey.serviceProvider as TorusServiceProvider).verifierName = verifier;
  (tKey.serviceProvider as TorusServiceProvider).verifierId = verifierId;
  const loginResponse: TorusLoginResponse = {
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

const addFactorKeyMetadata = async (factorKey: BN, tssShare: BN, tssIndex: number, factorKeyDescription: string) => {
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

function Auth() {
  const location = useLocation();
  const navigate = useNavigate();

  const [user, setUser] = useState<TorusVerifierResponse & LoginWindowResponse>(null);
  const [loginResponse, setLoginResponse] = useState<TorusLoginResponse>(null);
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
    localStorage.setItem("tKeyLocalStore", localFactorKey.toString("hex"));
  }, [localFactorKey]);

  // Gets the OAuth response
  useEffect(() => {
    async function getKeys() {
      const params = new URLSearchParams(location.hash.slice(1));
      const loginType = params.get("type");
      let currentLoginResponse: TorusLoginResponse;
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
          currentLoginResponse = response.result as TorusLoginResponse;
        } else {
          console.error("Invalid login response", response);
        }
        uiConsole("This is the login response:", currentLoginResponse);
      }
      if (currentLoginResponse) {
        setLoginResponse(currentLoginResponse);
        tKey.serviceProvider.postboxKey = new BN(currentLoginResponse.privateKey, "hex");
        (tKey.serviceProvider as TorusServiceProvider).verifierName = currentLoginResponse.userInfo.verifier;
        (tKey.serviceProvider as TorusServiceProvider).verifierId = currentLoginResponse.userInfo.verifierId;
      }
    }

    console.log("current hash", location.hash);
    if (location.hash) getKeys();
    else {
      navigate({ pathname: "/" });
    }
  }, []);

  // Initialize TKey
  useEffect(() => {
    async function initializeTKey() {
      // debugger;
      setOAuthShare(new BN(loginResponse.privateKey, 16));

      const signatures = loginResponse.signatures.filter((sign) => sign !== null);
      const verifierId = loginResponse.userInfo.name;

      const currentFactorKey: string = localStorage.getItem("tKeyLocalStore");

      // Right not we're depending on if local storage exists to tell us if
      // user is new or existing. TODO: change to depend on intiialize, then rehydrate
      let factorKey: BN;
      let deviceTSSShare: BN;
      let deviceTSSIndex: number;
      let existingUser = false;
      let metadataDeviceShare: ShareStore;
      if (!currentFactorKey) {
        factorKey = new BN(generatePrivate());
        deviceTSSShare = new BN(generatePrivate());
        deviceTSSIndex = 2;
      } else {
        factorKey = new BN(currentFactorKey, "hex");
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
        // await tKey.reconstructKey();
      } else {
        await tKey.initialize({ useTSS: true, factorPub, deviceTSSShare, deviceTSSIndex });
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

  const keyDetails = async () => {
    if (!tKey) {
      uiConsole("tKey not initialized yet");
      return;
    }
    const keys = tKey.getKeyDetails();
    uiConsole(keys);
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
    if (!web3) {
      console.log("provider not initialized yet");
      return;
    }
    const chainId = await web3.eth.getChainId();
    uiConsole(chainId);
    return chainId;
  };

  const getAccounts = async () => {
    if (!web3) {
      console.log("provider not initialized yet");
      return;
    }
    const address = (await web3.eth.getAccounts())[0];
    uiConsole(address);
    return address;
  };

  const getBalance = async () => {
    if (!web3) {
      console.log("provider not initialized yet");
      return;
    }
    const address = (await web3.eth.getAccounts())[0];
    const balance = web3.utils.fromWei(
      await web3.eth.getBalance(address) // Balance is in wei
    );
    uiConsole(balance);
    return balance;
  };

  const signMessage = async (): Promise<any> => {
    if (!web3) {
      console.log("provider not initialized yet");
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
      console.log("provider not initialized yet");
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

      <footer className="footer">
        <a href="https://github.com/Web3Auth/examples/tree/main/tkey/tkey-react-example" target="_blank" rel="noopener noreferrer">
          Source code
        </a>
      </footer>
    </div>
  );
}

export default Auth;
