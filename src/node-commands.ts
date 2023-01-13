import {ProcessStatus, statusFromPM2} from './pm2';
import pm2 from 'pm2';
import {Command} from 'commander';
import path from 'path';
import {exec} from 'child_process';
import merge from 'deepmerge';
import axios from 'axios';
import {defaultConfig} from './config/default-config';
import fs from 'fs';
import {ethers} from 'ethers';
import {calculateCurrentRewards} from './utils';
import {BN} from 'ethereumjs-util';
const yaml = require('js-yaml');

let config = defaultConfig;

let staking = {
  rewardAddress: '',
  stakeAddress: '',
  stakeAmount: 0,
  isStaked: false,
};

if (fs.existsSync(path.join(process.cwd(), 'config.json'))) {
  const fileConfig = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.json')).toString()
  );
  config = merge(config, fileConfig, {arrayMerge: (target, source) => source});
}

if (fs.existsSync(path.join(__dirname, '../stake.json'))) {
  const stakeConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../stake.json')).toString()
  );
  staking = merge(staking, stakeConfig, {
    arrayMerge: (target, source) => source,
  });
}

export function registerNodeCommands(program: Command) {
  program
    .command('status')
    .description(
      'Show if validator is running or not; also the port and URL to connect to it'
    )
    .action(() => {
      pm2.describe('validator', async (err, descriptions) => {
        if (err) {
          console.error(err);
          return pm2.disconnect();
        }
        if (descriptions.length === 0) {
          console.log(
            yaml.dump({
              state: 'inactive',
            })
          );
          return pm2.disconnect();
        }
        const description = descriptions[0];
        const status: ProcessStatus = statusFromPM2(description);

        if (status.status !== 'stopped') {
          const nodeInfo = await axios
            .get(
              `http://${config.server.ip.externalIp}:${config.server.ip.externalPort}/nodeinfo`
            )
            .then(res => res.data)
            .catch(err => console.error(err));
          let accumulatedRewards = new BN(0);

          if (staking.isStaked) {
            try {
              accumulatedRewards = await calculateCurrentRewards(
                config,
                nodeInfo.nodeInfo.publicKey
              );
            } catch (error) {
              accumulatedRewards = new BN(0);
            }
          }

          console.log(
            yaml.dump({
              state: 'active', // TODO standby/syncing/active and fill empty values
              totalTimeValidating: status.uptimeInSeconds,
              lastActive: '',
              stakeAmount: staking.stakeAmount,
              stakeRequirement: '',
              stakeAddress: staking.stakeAddress,
              earnings: '',
              lastPayout: '',
              lifetimeEarnings: '',
              cpuUsagePercent: status.cpuUsagePercent,
              memUsedInBytes: status.memUsedInBytes,
              currentRewards: ethers.utils.formatEther(
                accumulatedRewards.toString()
              ),
              nodeInfo: nodeInfo.nodeInfo,
            })
          );
        }

        return pm2.disconnect();
      });
    });

  program
    .command('start')
    .description('Starts the validator')
    .action(() => {
      // Save config in current directory to be used by the validator
      fs.writeFile(
        path.join(process.cwd(), 'config.json'),
        JSON.stringify(config, undefined, 2),
        err => {
          if (err) console.log(err);
        }
      );

      // Run the validators clean script
      //TODO: Inject port numbers from config as env vars into pm2
      exec(`node ${path.join(__dirname, '../../../scripts/clean.js')}`, () => {
        // Exec PM2 to start the shardeum validator
        pm2.connect(err => {
          if (err) {
            console.error(err);
            throw 'Unable to connect to PM2';
          }
          pm2.start(
            {
              script: `${path.join(__dirname, '../../../dist/src/index.js')}`,
              name: 'validator',
              output: './validator-logs.txt',
              autorestart: false, // Prevents the node from restarting if it is stopped by '/stop'
            },
            err => {
              if (err) console.error(err);
              return pm2.disconnect();
            }
          );
        });
      });
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
          if (err) console.log(err);
          return pm2.disconnect();
        });
      });
    });

  program
    .command('stake')
    .description(
      'Stake the set amount of SHM at the stake address. Rewards will be sent to set reward address.'
    )
    .action(async () => {
      //TODO should we handle consecutive stakes?

      if (staking.stakeAmount === 0) {
        console.error('Stake amount set to 0');
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
          'http://localhost:8080' //TODO Set JSON-RPC from config
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
          nominator: staking.rewardAddress,
          timestamp: Date.now(),
          nominee: staking.stakeAddress,
          stake: ethers.utils
            .parseEther(String(staking.stakeAmount))
            .toString(),
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
            if (err) console.log(err);
          }
        );
      } catch (error) {
        console.log(error);
      }
    });

  program
    .command('unstake')
    .description('Remove staked SHM')
    .action(async () => {
      //TODO should we handle partial unstakes?

      if (!staking.isStaked) {
        console.error('No SHM staked');
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
          'http://localhost:8080'
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

        const unstakeData = {
          isInternalTx: true,
          internalTXType: 7,
          nominator: staking.rewardAddress,
          timestamp: Date.now(),
          nominee: staking.stakeAddress,
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
            if (err) console.log(err);
          }
        );
      } catch (error) {
        console.log(error);
      }
    });

  // program
  //   .command('joined')
  //   .description('Check the validator state standby/syncing/active')
  //   .action(() => {
  //     //TODO interact with node
  //   });

  program
    .command('reward_address')
    .description('Query the validator reward address')
    .action(() => {
      console.log(staking.rewardAddress);
    });

  program
    .command('stake_amount')
    .description('Query the set stake amount')
    .action(() => {
      console.log(staking.stakeAmount);
    });

  program
    .command('stake_address')
    .description('Query the validator stake address')
    .action(() => {
      console.log(staking.stakeAddress);
    });

  // program
  //   .command('version')
  //   .description('Shows my version, latest version and minimum version')
  //   .action(() => {
  //     //TODO interact with node
  //   });

  program
    .command('update')
    .description('Shows instructions for version update')
    .action(() => {
      console.log('Run the ./update.sh script in the installer root directory');
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
        path.join(process.cwd(), 'config.json'),
        JSON.stringify(config, undefined, 2),
        err => {
          if (err) console.log(err);
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
        path.join(process.cwd(), 'config.json'),
        JSON.stringify(config, undefined, 2),
        err => {
          if (err) console.log(err);
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
        path.join(process.cwd(), 'config.json'),
        JSON.stringify(config, undefined, 2),
        err => {
          if (err) console.log(err);
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
        path.join(process.cwd(), 'config.json'),
        JSON.stringify(config, undefined, 2),
        err => {
          if (err) console.log(err);
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
          if (err) console.log(err);
        }
      );
      //TODO: Send TX
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
          if (err) console.log(err);
        }
      );
      //TODO: Send TX
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
          if (err) console.log(err);
        }
      );
      //TODO: Send TX
    });
}
