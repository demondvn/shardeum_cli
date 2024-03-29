import { Pm2ProcessStatus, statusFromPM2 } from './pm2';
import pm2 from 'pm2';
import { Command } from 'commander';
import path from 'path';
import { exec } from 'child_process';
import merge from 'deepmerge';
import { defaultConfig } from './config/default-network-config';
import {defaultNodeConfig, nodeConfigType} from './config/default-node-config';
import fs, { readFileSync } from 'fs';
import { ethers } from 'ethers';
import {
  fetchEOADetails,
  getNetworkParams,
  fetchStakeParameters,
  getAccountInfoParams,
  fetchValidatorVersions,
  getNodeSettings,
  cache,
  File,
  fetchNodeInfo,
  getUserInput,
} from './utils';
import {getPerformanceStatus} from './utils/performance-stats';
const yaml = require('js-yaml');
import {
  getInstalledGuiVersion,
  getInstalledValidatorVersion,
  getLatestCliVersion,
  getLatestGuiVersion,
  isGuiInstalled,
  isValidatorInstalled,
} from './utils/project-data';
import {fetchNodeProgress, getExitInformation, getProgressData} from './utils/fetch-node-data';
import axios from 'axios';
import {isValidPrivate} from 'ethereumjs-util';

let config = defaultConfig;
let nodeConfig: nodeConfigType = defaultNodeConfig;

let rpcServer = {
  url: 'https://sphinx.shardeum.org',
};

const stateMap: {[id: string]: string} = {
  null: 'standby',
  syncing: 'syncing',
  active: 'active',
};

if (fs.existsSync(path.join(__dirname, '../config.json'))) {
  const fileConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../config.json')).toString()
  );
  config = merge(config, fileConfig, { arrayMerge: (target, source) => source });
}

if (fs.existsSync(path.join(__dirname, '../nodeConfig.json'))) {
  const fileConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../nodeConfig.json')).toString()
  );
  nodeConfig = merge(nodeConfig, fileConfig, {
    arrayMerge: (target, source) => source,
  });
}

if (fs.existsSync(path.join(__dirname, '../rpc-server.json'))) {
  const fileConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../rpc-server.json')).toString()
  );
  rpcServer = merge(rpcServer, fileConfig, {
    arrayMerge: (target, source) => source,
  });
}

if (process.env.APP_SEEDLIST) {
  config = merge(
    config,
    {
      server: {
        p2p: {
          existingArchivers: [
            {
              ip: process.env.APP_SEEDLIST,
              port: 4000,
              publicKey:
                '758b1c119412298802cd28dbfa394cdfeecc4074492d60844cc192d632d84de3',
            },
          ],
        },
      },
    },
    { arrayMerge: (target, source) => source }
  );
}

if (process.env.EXISTING_ARCHIVERS) {
  const existingArchivers = JSON.parse(process.env.EXISTING_ARCHIVERS);
  if (existingArchivers.length > 0) {
    config = merge(
      config,
      {
        server: {
          p2p: {
            existingArchivers,
          },
        },
      },
      {arrayMerge: (target, source) => source}
    );
  }
}

if (process.env.APP_MONITOR) {
  config = merge(
    config,
    {
      server: {
        reporting: {
          recipient: `http://${process.env.APP_MONITOR}:3000/api`,
        },
      },
    },
    { arrayMerge: (target, source) => source }
  );
}

if (process.env.EXT_IP) {
  config = merge(
    config,
    {
      server: {
        ip: {
          externalIp:
            process.env.EXT_IP === 'auto'
              ? process.env.SERVERIP
              : process.env.EXT_IP,
        },
      },
    },
    { arrayMerge: (target, source) => source }
  );
}

if (process.env.INT_IP) {
  config = merge(
    config,
    {
      server: {
        ip: {
          internalIp:
            process.env.INT_IP === 'auto'
              ? process.env.SERVERIP
              : process.env.INT_IP,
        },
      },
    },
    {arrayMerge: (target, source) => source}
  );
}

if (process.env.SHMEXT) {
  config = merge(config, {
    server: {
      ip: {
        externalPort: parseInt(process.env.SHMEXT),
      },
    },
  });
}

if (process.env.SHMINT) {
  config = merge(config, {
    server: {
      ip: {
        internalPort: parseInt(process.env.SHMINT),
      },
    },
  });
}

const dashboardPackageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
);

fs.writeFileSync(
  path.join(__dirname, '../config.json'),
  JSON.stringify(config, undefined, 2)
);

fs.writeFileSync(
  path.join(__dirname, '../nodeConfig.json'),
  JSON.stringify(nodeConfig, undefined, 2)
);

export function registerNodeCommands(program: Command) {
  program
    .command('status')
    .description(
      'Show if validator is running or not; also the port and URL to connect to it'
    )
    .action(async () => {
      pm2.describe('validator', async (err, descriptions) => {
        // PM2 not reachable
        if (err) {
          console.error(err);
          return pm2.disconnect();
        }

        let publicKey = '';
        // Fetch the public key from secrets.json if it exists
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        if (fs.existsSync(path.join(__dirname, `../${File.SECRETS}`))) {
          const secrets = JSON.parse(
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            fs
              .readFileSync(path.join(__dirname, `../${File.SECRETS}`))
              .toString()
          );
          publicKey = secrets.publicKey;
        }

        const [
          {stakeRequired},
          performance,
          {totalTimeValidating, lastRotationIndex, lastActive},
          {exitMessage, exitStatus},
          accountInfo,
        ] = await Promise.all([
          fetchStakeParameters(config),
          getPerformanceStatus(),
          fetchNodeProgress().then(getProgressData),
          getExitInformation(),
          getAccountInfoParams(config, publicKey),
        ]);
        // TODO: Use Promise.allSettled. Need to update nodeJs to 12.9

        if (descriptions.length === 0) {
          // Node process not started
          console.log(
            yaml.dump({
              state: 'stopped',
              exitMessage,
              exitStatus,
              performance,
              stakeRequirement: stakeRequired
                ? ethers.utils.formatEther(stakeRequired)
                : '',
              lockedStake: accountInfo.lockedStake
                ? ethers.utils.formatEther(accountInfo.lockedStake)
                : '',
            })
          );
          cache.writeMaps();
          return pm2.disconnect();
        }

        const description = descriptions[0];
        const status: Pm2ProcessStatus = statusFromPM2(description);
        if (status.status !== 'stopped') {
          // Node is started and active

          const nodeInfo = await fetchNodeInfo(config);

          const lockedStakeStr = accountInfo.lockedStake
            ? ethers.utils.formatEther(accountInfo.lockedStake)
            : '';
          const nodeStatus =
            nodeInfo.status === null
              ? lockedStakeStr === '0.0'
                ? 'need-stake'
                : 'standby'
              : nodeInfo.status;

          console.log(
            yaml.dump({
              state: nodeStatus,
              exitMessage,
              exitStatus,
              totalTimeRunning: status.uptimeInSeconds,
              totalTimeValidating: totalTimeValidating,
              lastActive: lastActive,
              lastRotationIndex: lastRotationIndex,
              stakeRequirement: stakeRequired
                ? ethers.utils.formatEther(stakeRequired)
                : '',
              nominatorAddress: accountInfo.nominator,
              nomineeAddress: publicKey,
              performance,
              currentRewards: ethers.utils.formatEther(
                accountInfo.accumulatedRewards.toString()
              ),
              lockedStake: lockedStakeStr,
              nodeInfo: nodeInfo,
              // TODO: Add fetching node info when in standby
            })
          );
          cache.writeMaps();
          return pm2.disconnect();
        }

        // Node was started but is currently inactive
        console.log(
          yaml.dump({
            state: 'stopped',
            exitMessage,
            exitStatus,
            performance,
            stakeRequirement: stakeRequired
              ? ethers.utils.formatEther(stakeRequired)
              : '',
            lockedStake: accountInfo.lockedStake
              ? ethers.utils.formatEther(accountInfo.lockedStake)
              : '',
            nominatorAddress: accountInfo.nominator,
            currentRewards: accountInfo
              ? ethers.utils.formatEther(
                  accountInfo.accumulatedRewards.toString()
                )
              : '',
          })
        );
        cache.writeMaps();
        return pm2.disconnect();
      });
    });

  program
    .command('stake_info')
    .description('Show staking info for a particular EOA account')
    .argument('<address>', 'The EOA address to fetch stake info for')
    .action(async address => {
      if (!ethers.utils.isAddress(address)) {
        console.error('Invalid address entered');
        return;
      }

      try {
        const eoaData = await fetchEOADetails(config, address);
        console.log(
          yaml.dump({
            stake: eoaData?.operatorAccountInfo
              ? ethers.utils.formatEther(
                  String(parseInt(eoaData.operatorAccountInfo.stake, 16))
                )
              : '',
            nominee: eoaData?.operatorAccountInfo
              ? eoaData.operatorAccountInfo.nominee
              : '',
          })
        );
      } catch (error) {
        console.error(error);
      }
    });

  program
    .command('start')
    .description('Starts the validator')
    .action(async () => {
      // Run the validators clean script
      const res =await axios.get('https://ipinfo.io/ip')
      const APP_IP = res.data
      exec('export APP_IP='+APP_IP)
      exec(
        `node ${path.join(__dirname, '../../../validator/scripts/clean.js')}`,
        () => {
          // Exec PM2 to start the shardeum validator
          pm2.connect(err => {
            if (err) {
              console.error(err);
              throw 'Unable to connect to PM2';
            }
            pm2.start(
              {
                script: `${path.join(
                  __dirname,
                  '../../../validator/dist/src/index.js'
                )}`,
                name: 'validator',
                output: './validator-logs.txt',
                cwd: path.join(__dirname, '../'),
                autorestart: false, // Prevents the node from restarting if it is stopped by '/stop'
                env:{
                  "SERVERIP":res.data,
                  APP_IP:res.data
                }
              },
              err => {
                if (err) console.error(err);
                return pm2.disconnect();
              }
            );

          });
        }
      );
    });

  program
    .command('stop')
    .description('Stops the validator')
    .option(
      '-f, --force',
      'stops the node even if it is participating and could get slashed'
    )
    .action(options => {
      // Exec PM2 to stop the shardeum validator
      pm2.connect(err => {
        if (err) {
          console.error(err);
          throw 'Unable to connect to PM2';
        }

        if (!options.force) {
          //TODO check to make sure the node is not participating
        }

        pm2.stop('validator', err => {
          if (err) console.error(err);
          return pm2.disconnect();
        });
      });
    });

  program
    .command('stake')
    .argument('<value>', 'The amount of SHM to stake')
    .description(
      'Stake the set amount of SHM at the stake address. Rewards will be sent to set reward address.'
    )
    .action(async stakeValue => {
      //TODO should we handle consecutive stakes?

      // Fetch the public key from secrets.json
      if (!fs.existsSync(path.join(__dirname, '../secrets.json'))) {
        console.error('Please start the node once before staking');
        return;
      }

      const secrets = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../secrets.json')).toString()
      );

      if (secrets.publicKey === null) {
        console.error('Unable to find public key in secrets.json');
        return;
      }

      // Take input from user for PRIVATE KEY
      let privateKey = await getUserInput('Please enter your private key: ');
      while (
        privateKey.length !== 64 ||
        !isValidPrivate(Buffer.from(privateKey, 'hex'))
      ) {
        console.log('Invalid private key entered.');
        privateKey = await getUserInput('Please enter your private key: ');
      }

      const provider = new ethers.providers.JsonRpcProvider(rpcServer.url);

      const walletWithProvider = new ethers.Wallet(privateKey, provider);

      const [{stakeRequired}, eoaData] = await Promise.all([
        fetchStakeParameters(config),
        fetchEOADetails(config, walletWithProvider.address),
      ]);

      if (
        ethers.BigNumber.from(stakeRequired).gt(
          ethers.utils.parseEther(stakeValue)
        )
      ) {
        if (eoaData === null) {
          /*prettier-ignore*/
          console.error(`Stake amount must be greater than ${ethers.utils.formatEther(stakeRequired)} SHM`);
          return;
        }
      }

      try {
        const [gasPrice, from, nonce] = await Promise.all([
          walletWithProvider.getGasPrice(),
          walletWithProvider.getAddress(),
          walletWithProvider.getTransactionCount(),
        ]);

        const stakeData = {
          isInternalTx: true,
          internalTXType: 6,
          nominator: walletWithProvider.address.toLowerCase(),
          timestamp: Date.now(),
          nominee: secrets.publicKey,
          stake: ethers.utils.parseEther(stakeValue).toString(),
        };
        const value = ethers.BigNumber.from(stakeData.stake);
        console.log(stakeData);

        const txDetails = {
          from,
          to: '0x0000000000000000000000000000000000000001',
          gasPrice,
          gasLimit: 30000000,
          value,
          data: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes(JSON.stringify(stakeData))
          ),
          nonce,
        };

        const { hash, data, wait } = await walletWithProvider.sendTransaction(
          txDetails
        );

        console.log('TX RECEIPT: ', { hash, data });
        const txConfirmation = await wait();
        console.log('TX CONFRIMED: ', txConfirmation);
      } catch (error) {
        console.error(error);
      }
    });

  program
    .command('unstake')
    .description('Remove staked SHM')
    .option(
      '-f, --force',
      'Force unstake in case the node is stuck, will forfeit rewards'
    )
    .action(async options => {
      //TODO should we handle partial unstakes?

      // Take input from user for PRIVATE KEY
      let privateKey = await getUserInput('Please enter your private key: ');
      while (
        privateKey.length !== 64 ||
        !isValidPrivate(Buffer.from(privateKey, 'hex'))
      ) {
        console.log('Invalid private key entered.');
        privateKey = await getUserInput('Please enter your private key: ');
      }

      try {
        const provider = new ethers.providers.JsonRpcProvider(rpcServer.url);

        const walletWithProvider = new ethers.Wallet(
          privateKey,
          provider
        );

        const eoaData = await fetchEOADetails(
          config,
          walletWithProvider.address
        );

        if (
          eoaData.operatorAccountInfo.nominee === null ||
          eoaData.operatorAccountInfo.stake === '00'
        ) {
          console.error('No stake found');
          return;
        }

        const [gasPrice, from, nonce] = await Promise.all([
          walletWithProvider.getGasPrice(),
          walletWithProvider.getAddress(),
          walletWithProvider.getTransactionCount(),
        ]);

        const unstakeData = {
          isInternalTx: true,
          internalTXType: 7,
          nominator: walletWithProvider.address.toLowerCase(),
          timestamp: Date.now(),
          nominee: eoaData.operatorAccountInfo.nominee,
          force: options.force ?? false,
        };
        console.log(unstakeData);

        const txDetails = {
          from,
          to: '0x0000000000000000000000000000000000000001',
          gasPrice,
          gasLimit: 30000000,
          data: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes(JSON.stringify(unstakeData))
          ),
          nonce,
        };
        console.log(txDetails);

        const { hash, data, wait } = await walletWithProvider.sendTransaction(
          txDetails
        );

        console.log('TX RECEIPT: ', { hash, data });
        const txConfirmation = await wait();
        console.log('TX CONFRIMED: ', txConfirmation);
      } catch (error) {
        console.error(error);
      }
    });

  program
    .command('update')
    .description('Update the CLI and the GUI')
    .action(() => {
      exec(
        'sh update.sh',
        { cwd: path.join(__dirname, '../..') },
        (error, stdout, stderr) => {
          console.log(stdout);
          console.log(stderr);
          if (error !== null) {
            console.log(`exec error: ${error}`);
          }
        }
      );

      exec(
        'sh update.sh',
        { cwd: path.join(__dirname, '../../../gui') },
        (error, stdout, stderr) => {
          console.log(stdout);
          console.log(stderr);
          if (error !== null) {
            console.log(`exec error: ${error}`);
          }
        }
      );
    });

  program
    .command('version')
    .description(
      'Shows the installed version, latest version and minimum version of the operator dashboard'
    )
    .action(async () => {
      const validatorVersions = await fetchValidatorVersions(config);

      let versions: any = {
        runningCliVersion: dashboardPackageJson.version,
        minimumCliVersion: '0.1.0', //TODO query from some official online source
        latestCliVersion: await getLatestCliVersion(),
        minShardeumVersion: validatorVersions.minVersion,
        activeShardeumVersion: validatorVersions.activeVersion,
      };

      if (isGuiInstalled()) {
        versions = {
          ...versions,
          runningGuiVersion: getInstalledGuiVersion(),
          minimumGuiVersion: '0.1.0', //TODO query from some official online source
          latestGuiVersion: await getLatestGuiVersion(),
        };
      }

      if (isValidatorInstalled()) {
        versions = {
          ...versions,
          runnningValidatorVersion: getInstalledValidatorVersion(),
        };
      }
      console.log(yaml.dump(versions));
    });

  program
    .command('network-stats')
    .description(
      'Show statistics like TPS, active nodes etc. about the network'
    )
    .action(async () => {
      pm2.describe('validator', async (err, [descriptions]) => {
        if (!err) {
          const networkStats = await getNetworkParams(config, descriptions);
          console.log(yaml.dump(networkStats));
        }

        pm2.disconnect();
      });
    });

  program
    .command('node-settings')
    .description('Display node settings')
    .action(() => {
      const settings = getNodeSettings();
      console.log(
        yaml.dump({
          autoRestart: settings.autoRestart,
        })
      );
    });

  const setCommand = program
    .command('set')
    .description('command to set various config parameters');

  setCommand
    .command('external_port')
    .arguments('<port>')
    .description('Set the external port for the validator')
    .action(port => {
      config.server.ip.externalPort = parseInt(port);
      fs.writeFile(
        path.join(__dirname, '../config.json'),
        JSON.stringify(config, undefined, 2),
        err => {
          if (err) console.error(err);
        }
      );
    });

  setCommand
    .command('internal_port')
    .arguments('<port>')
    .description('Set the internal port for the validator')
    .action(port => {
      config.server.ip.internalPort = parseInt(port);
      fs.writeFile(
        path.join(__dirname, '../config.json'),
        JSON.stringify(config, undefined, 2),
        err => {
          if (err) console.error(err);
        }
      );
    });

  setCommand
    .command('external_ip')
    .arguments('<ip>')
    .description('Set the external ip for the validator')
    .action(ip => {
      config.server.ip.externalIp = ip;
      fs.writeFile(
        path.join(__dirname, '../config.json'),
        JSON.stringify(config, undefined, 2),
        err => {
          if (err) console.error(err);
        }
      );
    });

  setCommand
    .command('internal_ip')
    .arguments('<ip>')
    .description('Set the internal ip for the validator')
    .action(ip => {
      config.server.ip.internalIp = ip;
      fs.writeFile(
        path.join(__dirname, '../config.json'),
        JSON.stringify(config, undefined, 2),
        err => {
          if (err) console.error(err);
        }
      );
    });

  setCommand
    .command('rpc_url')
    .argument('<url>')
    .description("Set the RPC server's URL")
    .action(url => {
      rpcServer.url = url;
      fs.writeFile(
        path.join(__dirname, '../rpc-server.json'),
        JSON.stringify(rpcServer, undefined, 2),
        err => {
          if (err) console.error(err);
        }
      );
    });

  setCommand
    .command('auto_restart')
    .argument('<true/false>')
    .description(
      'To autostart the node after being rotated out. Set autostart to true or false'
    )
    .action((autostart: string) => {
      const input = autostart.toLowerCase();
      if (input !== 'true' && input !== 'false') {
        console.error('Invalid input. Please enter true or false');
        return;
      }
      nodeConfig.autoRestart = input === 'true';
      fs.writeFile(
        path.join(__dirname, '../nodeConfig.json'),
        JSON.stringify(nodeConfig, undefined, 2),
        err => {
          if (err) console.error(err);
        }
      );
    });

  // setCommand
  //   .command('archiver')
  //   .arguments('<URL>')
  //   .description('Set the URL for the archiver')
  //   .action(url => {
  //     //TODO interact with node
  //   });
}