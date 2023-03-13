import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { TorusServiceProvider } from "@tkey/service-provider-torus";
import { get, post } from "@toruslabs/http-helpers";
import debounce from "lodash.debounce";
import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { tKey } from "./tkey";
import { BACKEND_URL, uiConsole, wcVerifier } from "./utils";

function Login() {
  const [email, setEmail] = useState("chai@tor.us");
  const [isWebAuthnLoginEnabled, setIsWebAuthnLoginEnabled] = useState(false);
  const [isWebAuthnRegistrationEnabled, setIsWebAuthnRegistrationEnabled] = useState(false);
  const navigate = useNavigate();
  const isWebAuthnSupported = browserSupportsWebAuthn();
  console.log(isWebAuthnSupported, "isWebAuthnSupported");

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

  const onEmailChanged = (e: FormEvent<HTMLInputElement>) => {
    e.preventDefault();
    setEmail(e.currentTarget.value);
    if (isWebAuthnSupported && email.match(/^([\w.%+-]+)@([\w-]+\.)+([\w]{2,})$/i)) {
      debounce(async () => {
        try {
          console.log("fetching webauthn status");
          const url = new URL(`${BACKEND_URL}/api/v2/webauthn`);
          url.searchParams.append("email", email);
          const response = await get<{ success: boolean; data: { webauthn_enabled: boolean; cred_id: string; public_key: string } }>(url.href);
          if (response.success) {
            setIsWebAuthnLoginEnabled(true);
          } else {
            setIsWebAuthnRegistrationEnabled(true);
          }
        } catch (error) {
          console.error(error);
        }
      }, 500)();
    }
  };

  const triggerEmailLogin = async () => {
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

  const triggerPassKeyLogin = async () => {
    try {
      const url = new URL(`${BACKEND_URL}/api/v2/webauthn-generate-authentication-options`);
      url.searchParams.append("email", email);
      const resp = await get(url.href);
      const attestationResponse = await startAuthentication(resp);
      const url2 = new URL(`${BACKEND_URL}/api/v2/webauthn-verify-authentication`);
      const resp2 = await post<{ verified: boolean; id_token: string }>(url2.href, { attestationResponse, email });
      if (resp2.verified) {
        // Registration successful
        console.log("Login successful");
        navigate({ pathname: "/auth", hash: `type=webauthn&id_token=${resp2.id_token}&login_hint=${email}` });
        // get id token
      } else {
        throw new Error("Login failed");
      }
    } catch (error) {
      console.error(error);
    }
  };

  const triggerPassKeyRegistration = async () => {
    try {
      const url = new URL(`${BACKEND_URL}/api/v2/webauthn-generate-registration-options`);
      url.searchParams.append("email", email);
      const resp = await get(url.href);
      const attestationResponse = await startRegistration(resp);
      const url2 = new URL(`${BACKEND_URL}/api/v2/webauthn-verify-registration`);
      const resp2 = await post<{ verified: boolean }>(url2.href, { attestationResponse, email });
      if (resp2.verified) {
        // Registration successful
        console.log("Registration successful");
        // get id token
      } else {
        throw new Error("Registration failed");
      }
    } catch (error) {
      console.error(error);
    }
  };

  const triggerMockLogin = async () => {
    try {
      navigate({ pathname: "/auth", hash: "type=mock" });
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
        <input type="email" onChange={onEmailChanged} value={email} />
        <br />

        <button onClick={triggerEmailLogin} className="card">
          Login with Email
        </button>
        <br />
        <br />
        {isWebAuthnRegistrationEnabled && (
          <button onClick={triggerPassKeyRegistration} className="card">
            Register with PassKey
          </button>
        )}
        {isWebAuthnLoginEnabled && (
          <button onClick={triggerPassKeyLogin} className="card">
            Login with PassKey
          </button>
        )}
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
