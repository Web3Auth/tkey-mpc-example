import { TorusServiceProvider } from "@tkey/service-provider-torus";
import { LOGIN } from "@toruslabs/customauth";
import { ecCurve } from "@toruslabs/rss-client";
import { generateAddressFromPrivKey } from "@toruslabs/torus.js";
import BN from "bn.js";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { tKey } from "./tkey";
import { fetchPostboxKeyAndSigs, uiConsole, wcVerifier } from "./utils";

function Login() {
  const [email, setEmail] = useState("chai@tor.us");
  const navigate = useNavigate();

  useEffect(() => {
    const init = async () => {
      // Initialization of Service Provider
      try {
        await (tKey.serviceProvider as TorusServiceProvider).init({ skipInit: true });
      } catch (error) {
        uiConsole(error);
      }
    };
    init();
  }, []);

  const triggerLogin = async () => {
    try {
      // Triggering Login using Service Provider ==> opens the popup
      await (tKey.serviceProvider as TorusServiceProvider).triggerLogin({
        typeOfLogin: "jwt",
        verifier: wcVerifier,
        jwtParams: {
          domain: "https://wc-auth.web3auth.com",
          verifierIdField: "name",
          connection: "email",
          login_hint: email,
        },
        clientId: "QQRQNGxJ80AZ5odiIjt1qqfryPOeDcb1",
      });
    } catch (error) {
      uiConsole(error);
    }
  };

  const triggerMockLogin = async () => {
    try {
      navigate({ pathname: "/auth", hash: "mock=true" });
    } catch (error) {
      uiConsole(error);
    }
  };

  return (
    <div className="container">
      <h1 className="title">
        <a target="_blank" href="http://web3auth.io/" rel="noreferrer">
          Web3Auth (tKey)
        </a>
        & ReactJS Ethereum Example
      </h1>

      <div>
        <span>Enter your email: </span>
        <input type="email" onChange={(e) => setEmail(e.target.value)} value={email} />
        <br />

        <button onClick={triggerLogin} className="card">
          Login
        </button>
        <br />
        <br />
        <div>Or</div>
        <br />
        <button onClick={triggerMockLogin} className="card">
          MockLogin
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

export default Login;
