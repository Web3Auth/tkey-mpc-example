import { TorusServiceProvider } from "@tkey/service-provider-torus";
import { LOGIN } from "@toruslabs/customauth";
import { ecCurve } from "@toruslabs/rss-client";
import { generateAddressFromPrivKey } from "@toruslabs/torus.js";
import { BN } from "bn.js";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { tKey } from "./tkey";
import { fetchPostboxKeyAndSigs, uiConsole } from "./utils";

async function doMockLogin() {
  console.log("Mock login");
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
    publicAddress: generateAddressFromPrivKey(ecCurve, new BN(postboxkey, "hex")),
    metadataNonce: "",
  };
  uiConsole("This is the login response:", loginResponse);
}

function Auth() {
  const location = useLocation();
  useEffect(() => {
    async function getKeys() {
      console.log("Auth", location.hash);
      const params = new URLSearchParams(location.hash.slice(1));
      const isMock = params.get("mock");
      if (isMock === "true") {
        await doMockLogin();
      } else {
        const loginResponse = await (tKey.serviceProvider as TorusServiceProvider).directWeb.getRedirectResult();
        uiConsole("This is the login response:", loginResponse);
      }
    }

    if (location.hash) getKeys();
  }, []);
  return (
    <div className="container">
      <h1 className="title">
        <a target="_blank" href="http://web3auth.io/" rel="noreferrer">
          Web3Auth (tKey)
        </a>
        & ReactJS Ethereum Example
      </h1>

      <div></div>

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
