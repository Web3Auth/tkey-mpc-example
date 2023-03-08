import React, { useEffect, useState } from 'react';
import './App.css';
import { Client } from "@toruslabs/tss-client";
import * as tss from "@toruslabs/tss-lib";
import swal from 'sweetalert';
import {tKey} from "./tkey"
import { EthereumPrivateKeyProvider } from "@web3auth/ethereum-provider";
import Web3 from "web3";
import { generatePrivate } from "eccrypto";
import BN from "bn.js";
import { getPubKeyPoint } from "@tkey/common-types";
import { createSockets, fetchPostboxKeyAndSigs, getDKLSCoeff, getEcCrypto, getTSSPubKey } from "./utils";
import keccak256 from "keccak256";

const ec = getEcCrypto();

const factorKey = new BN(generatePrivate());
const factorPub = getPubKeyPoint(factorKey);

const deviceTSSShare = new BN(generatePrivate());
const deviceTSSIndex = 3;

const parties = 4;
const clientIndex = parties - 1;

const DELIMITERS = {
	Delimiter1: "\u001c",
	Delimiter2: "\u0015",
	Delimiter3: "\u0016",
	Delimiter4: "\u0017",
};

const randomSessionNonce = keccak256(generatePrivate().toString("hex") + Date.now());

const tssImportUrl = `${process.env.PUBLIC_URL}/dkls_19.wasm`;
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
	for (let i = 0; i < parties ; i++) {
	  partyIndexes.push(i);
	  if (i === clientIndex) {
		endpoints.push(null as any);
		tssWSEndpoints.push(null as any);
	  } else {
		endpoints.push(`https://sapphire-dev-2-${i+1}.authnetwork.dev/tss`);
		tssWSEndpoints.push(`https://sapphire-dev-2-${i+1}.authnetwork.dev`);
	  }
	}
	return { endpoints, tssWSEndpoints, partyIndexes };
};



function App() {
	const [user, setUser] = useState<any>(null);
	const [privateKey, setPrivateKey] = useState<any>();
	const [provider, setProvider] = useState<any>();
	const [tkeyObject] = useState<any>(tKey);
	const [signatures, setSignatures] = useState<any>(null);
	const [verifierId, setVerifierId] = useState<any>(null);

	const vid = `mpc-key-demo-passwordless${DELIMITERS.Delimiter1}${verifierId}`;

	// Init Service Provider inside the useEffect Method
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
		const ethProvider = async() => {
			const ethereumPrivateKeyProvider = new EthereumPrivateKeyProvider({
			  config: {
				/*
				pass the chain config that you want to connect with
				all chainConfig fields are required.
				*/
				chainConfig: {
				  chainId: "0x13881",
				  rpcTarget: "https://rpc.ankr.com/polygon_mumbai",
				  displayName: "Polygon Testnet",
				  blockExplorer: "https://mumbai.polygonscan.com",
				  ticker: "MATIC",
				  tickerName: "Matic",
				},
			  },
			});
			/*
			pass user's private key here.
			after calling setupProvider, we can use
			*/
			if(privateKey){
				await ethereumPrivateKeyProvider.setupProvider(privateKey);
				console.log(ethereumPrivateKeyProvider.provider);
				setProvider(ethereumPrivateKeyProvider.provider);
			}
		  }
		ethProvider();
	}, [privateKey]);

	const triggerLogin = async () => {
		if (!tKey) {
			uiConsole("tKey not initialized yet");
			return;
		}
		try {
			// Triggering Login using Service Provider ==> opens the popup
			const loginResponse = await (tKey.serviceProvider as any).triggerLogin({
				typeOfLogin: 'jwt',
				verifier: 'mpc-key-demo-passwordless',
				jwtParams: {
					domain: "https://shahbaz-torus.us.auth0.com",
					verifierIdField: "name",
				},
				clientId:
					'QQRQNGxJ80AZ5odiIjt1qqfryPOeDcb1',
			});
			console.log(loginResponse);

			setSignatures(loginResponse.signatures.filter(sign => sign !== null));
			setVerifierId(loginResponse.userInfo.name);
			setUser(loginResponse.userInfo);
			// uiConsole('Public Key : ' + loginResponse.publicAddress);
			// uiConsole('Email : ' + loginResponse.userInfo.email);
		} catch (error) {
			uiConsole(error);
		}
	};

	const initializeNewKey = async () => {
		if (!tKey) {
			uiConsole("tKey not initialized yet");
			return;
		}
		try {
			await triggerLogin(); // Calls the triggerLogin() function above


			// 1. setup
			// generate endpoints for servers
			const { endpoints, tssWSEndpoints, partyIndexes } = generateTSSEndpoints(parties,clientIndex);
			// setup mock shares, sockets and tss wasm files.
			const [sockets] = await Promise.all([
				setupSockets(tssWSEndpoints),
				tss.default(tssImportUrl),
			]);
			// Initialization of tKey
			await tKey.initialize({ useTSS: true, factorPub, deviceTSSShare, deviceTSSIndex });
			// Gets the deviceShare
			console.log(tKey);
			try {
				await (tKey.modules.webStorage as any).inputShareFromWebStorage(); // 2/2 flow
			} catch (e) {
				uiConsole(e);
				await recoverShare();
			}

			// Checks the requiredShares to reconstruct the tKey,
			// starts from 2 by default and each of the above share reduce it by one.
			const { requiredShares } = tKey.getKeyDetails();
			if (requiredShares > 0) {
				throw `Threshold not met. Required Share: ${requiredShares}`;
			}
			// 2. Reconstruct the Metadata Key
			const metadataKey = await tKey.reconstructKey();
			setPrivateKey(metadataKey?.privKey.toString("hex"))


			const tssNonce = tKey.metadata.tssNonces[tKey.tssTag];
			const factor1PubKeyDetails = await tKey.serviceProvider.getTSSPubKey(tKey.tssTag, tssNonce);
			const factor1PubKey = { x: factor1PubKeyDetails.x.toString("hex"), y: factor1PubKeyDetails.y.toString("hex") };
		  
			const { tssShare: factor2Share, tssIndex: factor2Index } = await tKey.getTSSShare(factorKey);
		  
			uiConsole(
				"factor2Index", factor2Index
			);
			// const session = `${vid}${DELIMITERS.Delimiter2}default${DELIMITERS.Delimiter3}${tssNonce}${
			//   DELIMITERS.Delimiter4
			//   }${randomSessionNonce.toString("hex")}`;

			// 3. get user's tss share from tkey.
			const factor2ECPK = ec.curve.g.mul(factor2Share);
			const factor2PubKey = { x: factor2ECPK.getX().toString("hex"), y: factor2ECPK.getY().toString("hex") };

			// 4. derive tss pub key, tss pubkey is implicitly formed using the dkgPubKey and the userShare (as well as userTSSIndex)
			const tssPubKey = getTSSPubKey(factor1PubKey, factor2PubKey, factor2Index);
			const compressedTSSPubKey = Buffer.from(`${tssPubKey.getX().toString(16, 64)}${tssPubKey.getY().toString(16,64)}`, "hex").toString("base64");

			uiConsole(
				"Successfully logged in & initialised MPC TKey SDK",
				"TSS Public Key: ", tssPubKey,
				"Factor 1 Public Key", factor1PubKey,
				"Factor 2 Public Key", factor2PubKey,
				"Metadata Key", metadataKey.privKey.toString("hex"),
			);
			//todo: check if the threshold for tss key meets

		} catch (error) {
			uiConsole(error, 'caught');
		}
	};

	const changeSecurityQuestionAndAnswer = async () => {
		if (!tKey) {
			uiConsole("tKey not initialized yet");
			return;
		}
		// swal is just a pretty dialog box
		swal('Enter password (>10 characters)', {
			content: 'input' as any,
		}).then(async value => {
			if (value.length > 10) {
				await (tKey.modules.securityQuestions as any).changeSecurityQuestionAndAnswer(value, 'whats your password?');
				swal('Success', 'Successfully changed new share with password.', 'success');
				uiConsole('Successfully changed new share with password.');
			} else {
				swal('Error', 'Password must be >= 11 characters', 'error');
			}
		});
		const keyDetails = await tKey.getKeyDetails();
		uiConsole(keyDetails);
	};

	const generateNewShareWithPassword = async () => {
		if (!tKey) {
			uiConsole("tKey not initialized yet");
			return;
		}
		// swal is just a pretty dialog box
		swal('Enter password (>10 characters)', {
			content: 'input' as any,
		}).then(async value => {
			if (value.length > 10) {
				try {
					await (tKey.modules.securityQuestions as any).generateNewShareWithSecurityQuestions(
						value,
						'whats your password?',
					);
					swal('Success', 'Successfully generated new share with password.', 'success');
					uiConsole('Successfully generated new share with password.');
				} catch (error) {
					swal('Error', (error as any)?.message.toString(), 'error');
				}
			} else {
				swal('Error', 'Password must be >= 11 characters', 'error');
			}
		});
	}

	const generateMnemonic = async () => {
		if (!tKey) {
			uiConsole("tKey not initialized yet");
			return;
		}
		try {
			const newShare = await tKey.generateNewShare();
			const mnemonic = await tKey.outputShare(newShare.newShareIndex, "mnemonic");
			uiConsole('Mnemonic: ' + mnemonic);
		} catch (error) {
			uiConsole(error);
		}
	};

	const backupShareRecover = async () => {
		if (!tKey) {
			uiConsole("tKey not initialized yet");
			return;
		}
		// swal is just a pretty dialog box
		swal('Enter mnemonic', {
			content: 'input' as any,
		}).then(async value => {
			try {
				await tKey.inputShare(value, "mnemonic"); // 2/2 flow
				// const { requiredShares } = tKey.getKeyDetails();
				// if (requiredShares <= 0) {
					const reconstructedKey = await tKey.reconstructKey();
					console.log(reconstructedKey)
					uiConsole(
						'Private Key: ' + reconstructedKey.privKey.toString("hex"),
						);
						setPrivateKey(reconstructedKey?.privKey.toString("hex"))
				// }
			} catch (error) {
				uiConsole(error);
			}
		});
	};

	const recoverShare = async () => {
		if (!tKey) {
			uiConsole("tKey not initialized yet");
			return;
		}
		// swal is just a pretty dialog box
		swal('Enter password (>10 characters)', {
			content: 'input' as any,
		}).then(async value => {
			if (value.length > 10) {
				try {
					await (tKey.modules.securityQuestions as any).inputShareFromSecurityQuestions(value); // 2/2 flow
					const { requiredShares } = tKey.getKeyDetails();
					if (requiredShares <= 0) {
						const reconstructedKey = await tKey.reconstructKey();
						setPrivateKey(reconstructedKey?.privKey.toString("hex"))
						uiConsole(
							'Private Key: ' + reconstructedKey.privKey.toString("hex"),
						);
					}
					const newShare = await tKey.generateNewShare();
					const shareStore = await tKey.outputShareStore(newShare.newShareIndex);
					await (tKey.modules.webStorage as any).storeDeviceShare(shareStore);
					swal('Success', 'Successfully logged you in with the recovery password.', 'success');
					uiConsole('Successfully logged you in with the recovery password.');
				} catch (error) {
					swal('Error', (error as any)?.message.toString(), 'error');
					uiConsole(error);
					logout();
				}
			} else {
				swal('Error', 'Password must be >= 11 characters', 'error');
				logout();
			}
		});
	}

	const keyDetails = async () => {
		if (!tKey) {
			uiConsole("tKey not initialized yet");
			return;
		}
		const keyDetails = await tKey.getKeyDetails();
		uiConsole(keyDetails);
	};

	const logout = (): void => {
		uiConsole('Log out');
		setUser(null);
	};

	const getUserInfo = (): void => {
		uiConsole(user);
	};

	const getPrivateKey = (): void => {
		uiConsole(privateKey);
	};

	const getChainID = async() => {
		if (!provider) {
			console.log("provider not initialized yet");
			return;
		}
		const web3 = new Web3(provider);
		const chainId = await web3.eth.getChainId();
		uiConsole(chainId)
	}

	const getAccounts = async() => {
		if (!provider) {
			console.log("provider not initialized yet");
			return;
		}
		const web3 = new Web3(provider);
		const address = (await web3.eth.getAccounts())[0];
		uiConsole(address)
	}

	const getBalance = async() => {
		if (!provider) {
			console.log("provider not initialized yet");
			return;
		}
		const web3 = new Web3(provider);
		const address = (await web3.eth.getAccounts())[0];
		const balance = web3.utils.fromWei(
			await web3.eth.getBalance(address) // Balance is in wei
		  );
		uiConsole(balance)
	}

	const signMessage = async(): Promise<any> => {
		if (!provider) {
			console.log("provider not initialized yet");
			return;
		}
		const web3 = new Web3(provider);
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
		uiConsole(signedMessage)
	}

	const sendTransaction = async() => {
		if (!provider) {
			console.log("provider not initialized yet");
			return;
		}
		const web3 = new Web3(provider);
		const fromAddress = (await web3.eth.getAccounts())[0];

		const destination = "0x7aFac68875d2841dc16F1730Fba43974060b907A";
		const amount = web3.utils.toWei("0.0001"); // Convert 1 ether to wei

		// Submit transaction to the blockchain and wait for it to be mined
		const receipt = await web3.eth.sendTransaction({
			from: fromAddress,
			to: destination,
			value: amount,
			maxPriorityFeePerGas: "5000000000", // Max priority fee per gas
			maxFeePerGas: "6000000000000", // Max fee per gas
		});
		uiConsole(receipt)
	}

	const uiConsole = (...args: any[]): void => {
		const el = document.querySelector('#console>p');
		if (el) {
			el.innerHTML = JSON.stringify(args || {}, null, 2);
		}
		console.log(...args);
	};

	const loggedInView = (
		<>
			<div className='flex-container'>
				<div>
					<button onClick={getUserInfo} className='card'>
						Get User Info
					</button>
				</div>
				<div>
					<button onClick={generateNewShareWithPassword} className='card'>
						Generate Password Share
					</button>
				</div>
				<div>
					<button onClick={changeSecurityQuestionAndAnswer} className='card'>
						Change Password Share
					</button>
				</div>
				<div>
					<button onClick={generateMnemonic} className='card'>
						Generate Backup (Mnemonic)
					</button>
				</div>
				<div>
					<button onClick={backupShareRecover} className='card'>
						Input Backup Share
					</button>
				</div>
				<div>
					<button onClick={keyDetails} className='card'>
						Key Details
					</button>
				</div>
				<div>
					<button onClick={getPrivateKey} className='card'>
						Private Key
					</button>
				</div>
				<div>
					<button onClick={getChainID} className='card'>
						Get Chain ID
					</button>
				</div>
				<div>
					<button onClick={getAccounts} className='card'>
						Get Accounts
					</button>
				</div>
				<div>
					<button onClick={getBalance} className='card'>
						Get Balance
					</button>
				</div>
				
				<div>
					<button onClick={signMessage} className='card'>
						Sign Message
					</button>
				</div>
				<div>
					<button onClick={sendTransaction} className='card'>
						Send Transaction
					</button>
				</div>
				<div>
					<button onClick={logout} className='card'>
						Log Out
					</button>
				</div>
			</div>

			<div id='console' style={{ whiteSpace: 'pre-line' }}>
				<p style={{ whiteSpace: 'pre-line' }}></p>
			</div>
		</>
	);

	const unloggedInView = (
		<button onClick={initializeNewKey} className='card'>
			Login
		</button>
	);

	return (
		<div className='container'>
			<h1 className='title'>
				<a target='_blank' href='http://web3auth.io/' rel='noreferrer'>
					Web3Auth (tKey)
				</a>
				& ReactJS Ethereum Example
			</h1>

			<div className='grid'>{user ? loggedInView : unloggedInView}</div>

			<footer className='footer'>
				<a
					href='https://github.com/Web3Auth/examples/tree/main/tkey/tkey-react-example'
					target='_blank'
					rel='noopener noreferrer'
				>
					Source code
				</a>
			</footer>
		</div>
	);
}

export default App;
