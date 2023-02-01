import {Pm2ProcessStatus, statusFromPM2} from './pm2';
import pm2 from 'pm2';
import {Command} from 'commander';
import path from 'path';
import {exec} from 'child_process';
import merge from 'deepmerge';
import axios from 'axios';
import {defaultConfig} from './config/default-config';
import fs, {readFileSync} from 'fs';
import {ethers} from 'ethers';
import {fetchEOADetails, getAccountInfoParams} from './utils';
import {getPerformanceStatus} from './utils/performance-stats';
const yaml = require('js-yaml');
import {getLatestCliVersion} from './utils/project-data';

let config = defaultConfig;

let staking = {
  rewardAddress: '',
  stakeAddress: '',
  stakeAmount: 0,
  isStaked: false,
};

let rpcServer = {
  ip: 'localhost',
  port: '8080',
};

const stateMap: {[id: string]: string} = {
  null: 'standby',
  syncing: 'active-syncing',
  active: 'active',
};

if (fs.existsSync(path.join(__dirname, '../config.json'))) {
  const fileConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../config.json')).toString()
  );
  config = merge(config, fileConfig, {arrayMerge: (target, source) => source});
}

if (fs.existsSync(path.join(__dirname, '../rpc-server.json'))) {
  const fileConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../rpc-server.json')).toString()
  );
  rpcServer = merge(rpcServer, fileConfig, {
    arrayMerge: (target, source) => source,
  });
}

if (fs.existsSync(path.join(__dirname, '../stake.json'))) {
  const stakeConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../stake.json')).toString()
  );
  staking = merge(staking, stakeConfig, {
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
    {arrayMerge: (target, source) => source}
  );
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
    {arrayMerge: (target, source) => source}
  );
}

if (process.env.APP_IP) {
  config = merge(
    config,
    {
      server: {
        ip: {
          externalIp:
            process.env.APP_IP === 'auto' ? '127.0.0.1' : process.env.APP_IP,
          internalIp:
            process.env.APP_IP === 'auto' ? '127.0.0.1' : process.env.APP_IP,
        },
      },
    },
    {arrayMerge: (target, source) => source}
  );
}
const dashboardPackageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
);

fs.writeFileSync(
  path.join(__dirname, '../config.json'),
  JSON.stringify(config, undefined, 2)
);

export function registerNodeCommands(program: Command) {
  program
    .command('status')
    .description(
      'Show if validator is running or not; also the port and URL to connect to it'
    )
    .action(() => {
      pm2.describe('validator', async (err, descriptions) => {
        // PM2 not reachable
        if (err) {
          console.error(err);
          return pm2.disconnect();
        }

        const {stakeRequired} = await getAccountInfoParams(config, 'none');
        const performance = await getPerformanceStatus();

        if (descriptions.length === 0) {
          // Node process not started
          console.log(
            yaml.dump({
              state: 'stopped',
              performance,
              stakeRequirement: stakeRequired
                ? ethers.utils.formatEther(stakeRequired)
                : '',
            })
          );
          return pm2.disconnect();
        }

        const description = descriptions[0];
        const status: Pm2ProcessStatus = statusFromPM2(description);
        if (status.status !== 'stopped') {
          // Node is started and active
          const nodeInfo = await axios
            .get(
              `http://${config.server.ip.externalIp}:${config.server.ip.externalPort}/nodeinfo`
            )
            .then(res => res.data)
            .catch(err => console.error(err));

          const nodeState = stateMap[nodeInfo.nodeInfo.status];

          //prettier-ignore
          const {nominator, accumulatedRewards, lockedStake} =
            await getAccountInfoParams(config, nodeInfo.nodeInfo.publicKey);

          console.log(
            yaml.dump({
              state: nodeState,
              totalTimeValidating: status.uptimeInSeconds,
              lastActive: '',
              stakeAmount: staking.stakeAmount,
              stakeRequirement: stakeRequired
                ? ethers.utils.formatEther(stakeRequired)
                : '',
              nominatorAddress: nominator,
              stakeAddress: staking.stakeAddress,
              earnings: '',
              lastPayout: '',
              lifetimeEarnings: '',
              performance,
              currentRewards: ethers.utils.formatEther(
                accumulatedRewards.toString()
              ),
              lockedStake: ethers.utils.formatEther(lockedStake.toString()),
              nodeInfo: nodeInfo.nodeInfo,
            })
          );

          return pm2.disconnect();
        }

        // Node was started but is currently inactive
        console.log(
          yaml.dump({
            state: 'stopped',
            performance,
            stakeRequirement: stakeRequired
              ? ethers.utils.formatEther(stakeRequired)
              : '',
          })
        );

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
            stake: ethers.utils.formatEther(
              String(parseInt(eoaData.operatorAccountInfo.stake, 16))
            ),
            nominee: eoaData.operatorAccountInfo.nominee,
          })
        );
      } catch (error) {
        console.error(error);
      }
    });

  program
    .command('start')
    .description('Starts the validator')
    .action(() => {
      // Save config in current directory to be used by the validator
      fs.writeFile(
        path.join(__dirname, '../config.json'),
        JSON.stringify(config, undefined, 2),
        err => {
          if (err) console.log(err);
        }
      );

      // Run the validators clean script
      //TODO: Inject port numbers from config as env vars into pm2
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

      if (stakeValue <= 0) {
        console.error('Stake amount must be non-zero');
        return;
      }
      if (!process.env.PRIV_KEY) {
        console.error(
          'Please set private key as PRIV_KEY environment variable'
        );
        return;
      }

      try {
        const provider = new ethers.providers.JsonRpcProvider(
          `http://${rpcServer.ip}:${rpcServer.port}`
        );

        const walletWithProvider = new ethers.Wallet(
          process.env.PRIV_KEY,
          provider
        );

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

        const {hash, data, wait} = await walletWithProvider.sendTransaction(
          txDetails
        );

        console.log('TX RECEIPT: ', {hash, data});
        const txConfirmation = await wait();
        console.log('TX CONFRIMED: ', txConfirmation);
        staking.isStaked = true;
        fs.writeFile(
          path.join(__dirname, '../stake.json'),
          JSON.stringify(staking, undefined, 2),
          err => {
            if (err) console.error(err);
          }
        );
      } catch (error) {
        console.error(error);
      }
    });

  program
    .command('unstake')
    .description('Remove staked SHM')
    .action(async () => {
      //TODO should we handle partial unstakes?

      if (!process.env.PRIV_KEY) {
        console.error(
          'Please set private key as PRIV_KEY environment variable'
        );
        return;
      }

      try {
        const provider = new ethers.providers.JsonRpcProvider(
          `http://${rpcServer.ip}:${rpcServer.port}`
        );

        const walletWithProvider = new ethers.Wallet(
          process.env.PRIV_KEY,
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

        const {hash, data, wait} = await walletWithProvider.sendTransaction(
          txDetails
        );

        console.log('TX RECEIPT: ', {hash, data});
        const txConfirmation = await wait();
        console.log('TX CONFRIMED: ', txConfirmation);
        staking.isStaked = false;
        fs.writeFile(
          path.join(__dirname, '../stake.json'),
          JSON.stringify(staking, undefined, 2),
          err => {
            if (err) console.error(err);
          }
        );
      } catch (error) {
        console.error(error);
      }
    });

  program
    .command('reward_address')
    .description('Query the validator reward address')
    .action(() => {
      console.log(
        yaml.dump({
          reward_address: staking.rewardAddress,
        })
      );
    });

  program
    .command('stake_amount')
    .description('Query the set stake amount')
    .action(() => {
      console.log(
        yaml.dump({
          stake_amount: staking.stakeAmount,
        })
      );
    });

  program
    .command('stake_address')
    .description('Query the validator stake address')
    .action(() => {
      console.log(
        yaml.dump({
          stake_address: staking.stakeAddress,
        })
      );
    });

  program
    .command('update')
    .description('Update the CLI and the GUI')
    .action(() => {
      exec(
        'sh update.sh',
        {cwd: path.join(__dirname, '../..')},
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
        {cwd: path.join(__dirname, '../../../gui')},
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
      console.log(
        yaml.dump({
          runningVersion: dashboardPackageJson.version,
          minimumVersion: '1.0.0', //TODO query from some official online source
          latestVersion: await getLatestCliVersion(),
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
    .command('rpc_ip')
    .argument('<ip>')
    .description("Set the RPC server's IP address")
    .action(ip => {
      rpcServer.ip = ip;
      fs.writeFile(
        path.join(__dirname, '../rpc-server.json'),
        JSON.stringify(rpcServer, undefined, 2),
        err => {
          if (err) console.error(err);
        }
      );
    });

  setCommand
    .command('rpc_port')
    .argument('<port>')
    .description("Set the RPC server's port")
    .action(port => {
      rpcServer.port = port;
      fs.writeFile(
        path.join(__dirname, '../rpc-server.json'),
        JSON.stringify(rpcServer, undefined, 2),
        err => {
          if (err) console.error(err);
        }
      );
    });

  setCommand
    .command('reward_address')
    .arguments('<address>')
    .description('Set the reward address for the validator')
    .action(address => {
      staking.rewardAddress = address;
      fs.writeFile(
        path.join(__dirname, '../stake.json'),
        JSON.stringify(staking, undefined, 2),
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

  setCommand
    .command('stake_address')
    .arguments('<address>')
    .description('Set the stake address')
    .action(address => {
      staking.stakeAddress = address;
      fs.writeFile(
        path.join(__dirname, '../stake.json'),
        JSON.stringify(staking, undefined, 2),
        err => {
          if (err) console.error(err);
        }
      );
    });

  setCommand
    .command('stake_amount')
    .arguments('<amount>')
    .description('Set the stake amount')
    .action(amount => {
      staking.stakeAmount = parseInt(amount); //Add checks for all parseInts
      fs.writeFile(
        path.join(__dirname, '../stake.json'),
        JSON.stringify(staking, undefined, 2),
        err => {
          if (err) console.error(err);
        }
      );
    });
}
