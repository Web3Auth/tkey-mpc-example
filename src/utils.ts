import { ShareStore } from "@tkey/common-types";
import TorusUtils from "@toruslabs/torus.js";
import BN from "bn.js";
import EC from "elliptic";
import rs from "jsrsasign";
import { io, Socket } from "socket.io-client";

export const wcVerifier = "passkeys-web3auth-demo";
export const BACKEND_URL = "https://wc-admin.web3auth.com";

const torusNodeEndpoints = [
  "https://sapphire-dev-2-1.authnetwork.dev/sss/jrpc",
  "https://sapphire-dev-2-2.authnetwork.dev/sss/jrpc",
  "https://sapphire-dev-2-3.authnetwork.dev/sss/jrpc",
  "https://sapphire-dev-2-4.authnetwork.dev/sss/jrpc",
  "https://sapphire-dev-2-5.authnetwork.dev/sss/jrpc",
];

export const torus = new TorusUtils({
  metadataHost: "https://sapphire-dev-2-1.authnetwork.dev/metadata",
  network: "cyan",
  enableOneKey: true,
});

export function getEcCrypto(): any {
  // eslint-disable-next-line new-cap
  return new EC.ec("secp256k1");
}

export function ecPoint(p: { x: string; y: string }): any {
  const ec = getEcCrypto();
  return ec.keyFromPublic({ x: p.x.padStart(64, "0"), y: p.y.padStart(64, "0") }).getPublic();
}

export const getAdditiveCoeff = (isUser: boolean, participatingServerIndexes: number[], userTSSIndex: number, serverIndex?: number): BN => {
  const ec = getEcCrypto();
  if (isUser) {
    return getLagrangeCoeffs([1, userTSSIndex], userTSSIndex);
  }
  // generate the lagrange coeff that converts the current server DKG share into an additive sharing
  const serverLagrangeCoeff = getLagrangeCoeffs(participatingServerIndexes, serverIndex);
  const masterLagrangeCoeff = getLagrangeCoeffs([1, userTSSIndex], 1);
  const additiveLagrangeCoeff = serverLagrangeCoeff.mul(masterLagrangeCoeff).umod(ec.curve.n);
  return additiveLagrangeCoeff;
};

// Note: this is only needed for DKLS and not for FROST
export const getDenormaliseCoeff = (party: number, parties: number[]): BN => {
  if (parties.indexOf(party) === -1) throw new Error(`party ${party} not found in parties ${parties}`);
  const ec = getEcCrypto();
  // generate the lagrange coeff that denormalises the additive sharing into the shamir sharing that TSS is expecting
  const denormaliseLagrangeCoeff = getLagrangeCoeffs(parties, party).invm(ec.curve.n).umod(ec.curve.n);
  return denormaliseLagrangeCoeff;
};

export const getDKLSCoeff = (isUser: boolean, participatingServerIndexes: number[], userTSSIndex: number, serverIndex?: number): BN => {
  const sortedServerIndexes = participatingServerIndexes.sort((a, b) => a - b);
  for (let i = 0; i < sortedServerIndexes.length; i++) {
    if (sortedServerIndexes[i] !== participatingServerIndexes[i]) throw new Error("server indexes must be sorted");
  }
  // generate denormalise coeff for DKLS
  const parties = [];

  // total number of parties for DKLS = total number of servers + 1 (user is the last party)
  // server party indexes
  let serverPartyIndex = 0;
  for (let i = 0; i < participatingServerIndexes.length; i++) {
    const currentPartyIndex = i + 1;
    parties.push(currentPartyIndex);
    if (participatingServerIndexes[i] === serverIndex) serverPartyIndex = currentPartyIndex;
  }
  const userPartyIndex = parties.length + 1;
  parties.push(userPartyIndex); // user party index
  if (isUser) {
    const additiveCoeff = getAdditiveCoeff(isUser, participatingServerIndexes, userTSSIndex, serverIndex);
    const denormaliseCoeff = getDenormaliseCoeff(userPartyIndex, parties);
    const ec = getEcCrypto();
    return denormaliseCoeff.mul(additiveCoeff).umod(ec.curve.n);
  }
  const additiveCoeff = getAdditiveCoeff(isUser, participatingServerIndexes, userTSSIndex, serverIndex);
  const denormaliseCoeff = getDenormaliseCoeff(serverPartyIndex, parties);
  const ec = getEcCrypto();
  const coeff = denormaliseCoeff.mul(additiveCoeff).umod(ec.curve.n);
  return coeff;
};

export function getLagrangeCoeffs(_allIndexes: number[] | BN[], _myIndex: number | BN, _target: number | BN = 0): BN {
  const ec = getEcCrypto();
  const allIndexes: BN[] = _allIndexes.map((i) => new BN(i));
  const myIndex: BN = new BN(_myIndex);
  const target: BN = new BN(_target);
  let upper = new BN(1);
  let lower = new BN(1);
  for (let j = 0; j < allIndexes.length; j += 1) {
    if (myIndex.cmp(allIndexes[j]) !== 0) {
      let tempUpper = target.sub(allIndexes[j]);
      tempUpper = tempUpper.umod(ec.curve.n);
      upper = upper.mul(tempUpper);
      upper = upper.umod(ec.curve.n);
      let tempLower = myIndex.sub(allIndexes[j]);
      tempLower = tempLower.umod(ec.curve.n);
      lower = lower.mul(tempLower).umod(ec.curve.n);
    }
  }
  return upper.mul(lower.invm(ec.curve.n)).umod(ec.curve.n);
}

export const createSockets = async (wsEndpoints: string[]): Promise<Socket[]> => {
  return wsEndpoints.map((wsEndpoint) => {
    if (wsEndpoint === null || wsEndpoint === undefined) {
      return null as any;
    }
    return io(wsEndpoint, {
      path: "/tss/socket.io",
      transports: ["websocket", "polling"],
      withCredentials: true,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: 10,
    });
  });
};

const jwtPrivateKey = `-----BEGIN PRIVATE KEY-----\nMEECAQAwEwYHKoZIzj0CAQYIKoZIzj0DAQcEJzAlAgEBBCCD7oLrcKae+jVZPGx52Cb/lKhdKxpXjl9eGNa1MlY57A==\n-----END PRIVATE KEY-----`;
export const generateIdToken = (email) => {
  const alg = "ES256";
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "torus-key-test",
    aud: "torus-key-test",
    name: email,
    email,
    scope: "email",
    iat,
    eat: iat + 120,
  };

  const options = {
    expiresIn: "120",
    algorithm: alg,
  };

  const header = { alg, typ: "JWT" };
  const token = rs.KJUR.jws.JWS.sign(alg, header, payload, jwtPrivateKey, options);

  return token;
};

export async function fetchPostboxKeyAndSigs(opts) {
  const { verifierName, verifierId } = opts;
  const token = generateIdToken(verifierId);

  const retrieveSharesResponse = await torus.retrieveShares(torusNodeEndpoints, verifierName, { verifier_id: verifierId }, token);

  const signatures = [];
  retrieveSharesResponse.sessionTokensData.filter((session) => {
    if (session) {
      signatures.push(
        JSON.stringify({
          data: session.token,
          sig: session.signature,
        })
      );
    }
    return null;
  });

  return {
    signatures,
    postboxkey: retrieveSharesResponse.privKey.toString(),
  };
}

export async function assignTssKey(opts) {
  const { verifierName, verifierId, tssTag = "default", nonce } = opts;
  const extendedVerifierId = `${verifierId}\u0015${tssTag}\u0016${nonce}`;
  const pubKeyDetails = await torus.getPublicAddress(torusNodeEndpoints, { verifier: verifierName, verifierId, extendedVerifierId }, true);

  return pubKeyDetails;
}

export function getTSSPubKey(dkgPubKey, userSharePubKey, userTSSIndex): any {
  const serverLagrangeCoeff = getLagrangeCoeffs([1, userTSSIndex], 1);
  const userLagrangeCoeff = getLagrangeCoeffs([1, userTSSIndex], userTSSIndex);
  const serverTerm = ecPoint(dkgPubKey).mul(serverLagrangeCoeff);
  const userTerm = ecPoint(userSharePubKey).mul(userLagrangeCoeff);
  return serverTerm.add(userTerm);
}

export const uiConsole = (...args: any[]): void => {
  const el = document.querySelector("#console>p");
  if (el) {
    el.innerHTML = JSON.stringify(args || {}, null, 2);
  }
  // eslint-disable-next-line no-console
  console.log(...args);
};

export type FactorKeyCloudMetadata = {
  deviceShare: ShareStore;
  tssShare: BN;
  tssIndex: number;
};

export const DELIMITERS = {
  Delimiter1: "\u001c",
  Delimiter2: "\u0015",
  Delimiter3: "\u0016",
  Delimiter4: "\u0017",
};
