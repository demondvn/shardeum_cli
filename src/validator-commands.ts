import axios from 'axios';
import { Command } from 'commander';

import { ethers } from 'ethers';
import fs from 'fs'
import path from 'path'
import pm2 from 'pm2';
const provider = new ethers.providers.JsonRpcProvider(
    `https://sphinx.shardeum.org:443`
);
async function nodelist() {
    const URL = 'archiver-sphinx.shardeum.org'
    const res = await axios.get('http://archiver-sphinx.shardeum.org:4000/nodelist')
    const root = res.data as NodeList.RootObject
    return root.nodeList
}
async function node_rpc() {
    const _nodelist = await nodelist()
    return `${_nodelist[0].ip}:${_nodelist[0].port}`
}
async function getNominee(rpc: string, address: string) {
    const url = `https://explorer-sphinx.shardeum.org/api/address?address=${address}&accountType=5`
    const res = await axios.get(url)
    const root = res.data as Account.RootObject
    if (root.accounts)
        return root.accounts[0].account?.operatorAccountInfo?.nominee
    return 'error'
}
//https://explorer-sphinx.shardeum.org/api/address?address=33cc9838948e3f3f81645d7f9094a9ce5867f6a7c49a223bac165fb354664f16&accountType=9
async function getInfoNode(rpc: string, address: string) {
    const url = `https://explorer-sphinx.shardeum.org/api/address?address=${address}&accountType=9`
    const res = await axios.get(url)
    const root = res.data as Account_9.RootObject
    return root
}
async function getBalanceEth(address: string) {
    const balanceWei = await provider.getBalance(address)
    return ethers.utils.formatEther(balanceWei + "")
}
async function transfer(from: Wallet, to: string, value: number) {
    const walletWithProvider = new ethers.Wallet(
        from.private_key,
        provider
    );
    try {
        const [nonce, gasPrice] = await Promise.all([
            walletWithProvider.getTransactionCount(from.address),
            walletWithProvider.getGasPrice()
        ])

        const status = await walletWithProvider.sendTransaction({
            to,
            value: ethers.utils.parseEther(value + ""),
            gasPrice,
            gasLimit: 30000,
            from: from.address,
            nonce,

        })
        await status.wait()
        // console.log(rs)
        return true
    } catch (error) {
        console.error(error)
    }
    return false
}
export async function stakes(stakeValue: string, wallets: string, backup: string) {
    // debugger
    const walletsJson: Wallet[] = JSON.parse(fs.readFileSync(wallets, 'utf8'));

    // Load all JSON files in backup folder
    const backupFiles: Backup[] = fs.readdirSync(backup)
        .filter(file => path.extname(file) === '.json')
        .map(file => JSON.parse(fs.readFileSync(path.join(backup, file), 'utf8')));

    const rpc = await node_rpc()
    const get_nominee = async (wallet: Wallet) => {
        const [nomi, balance] = await Promise.all([
            getNominee(rpc, wallet.address),
            getBalanceEth(wallet.address)
        ])
        wallet.nominee = nomi
        wallet.balanceEth = balance
        return wallet
    }
    const get_nominator = async (backup: Backup) => {
        const nominator = await getInfoNode(rpc, backup.publicKey)
        if (nominator.success)
            backup.nominator = nominator?.accounts[0]?.account?.nominator
        // backup.staked = !!nominator?.accounts[0]?.account
        return backup
    }
    // await Promise.all(
    //     walletsJson.map(i => get_nominee(i)))

    // await Promise.all(
    //     backupFiles.map(i => get_nominator(i))
    // )
    const minvalue = 11
    // const lst_backup_valid = backupFiles.filter(i => !i.nominator)
    // const lst_wallet_valid = walletsJson.filter(i => !i.nominee )
    // const lst_wallet_not_valid_has_money = walletsJson.filter(i => i.nominee && +(i.balanceEth || 0) > minvalue)
    // console.log('lst_backup_valid', lst_backup_valid.length, 'lst_wallet_valid', lst_wallet_valid.length, 'lst_wallet_not_valid_has_money', lst_wallet_not_valid_has_money.length)
    // debugger
    // for await (const backup of lst_backup_valid) {
    //     const wallet = lst_wallet_valid.shift()
    //     if (!wallet)
    //         continue
    //     if (+(wallet?.balanceEth || 0) < minvalue) {
    //         const sender = lst_wallet_not_valid_has_money.shift() as Wallet
    //         if (sender) {
    //             console.log('send', minvalue, sender.address, wallet?.address)
    //             const balanceEth = +(wallet?.balanceEth || 0)
    //             const needMore = minvalue - balanceEth +1 
    //             if(! await transfer(sender, wallet.address, needMore))
    //                 continue

    //         }
    //         const balance = await getBalanceEth(wallet.address)
    //         if (+balance < minvalue) {
    //             continue
    //         }
    //     }
    //     const status=await stake(stakeValue, wallet, backup.publicKey, 0)
    //     if(!status)
    //         lst_wallet_valid.push(wallet)


    //     // await new Promise(f => setTimeout(f, 3000));
    // }
    const lst_has_shm: Wallet[] = []
    const lst_need_shm: string[] = []
    const DoStake = async (backup: Backup) => {
        while (!backup.nominator) {
            await get_nominator(backup)
            if (!backup.nominator) {

                let wallet = walletsJson.shift()
                if (wallet) {

                    await get_nominee(wallet)
                    while (wallet?.nominee) {
                        console.log(wallet.nominee, wallet.address, 'staked')
                        const balance = +(wallet.balanceEth || 0)
                        if (balance > 2)
                            lst_has_shm.push(wallet)
                        wallet = walletsJson.shift()
                    }


                    if (wallet) {
                        if (!wallet?.nominee) {
                            const balance = +(wallet.balanceEth || 0)
                            if (balance < minvalue && lst_has_shm.length) {
                                let need = minvalue - balance + 1
                                need = need > 11 ? 11 : need
                                const sender = lst_has_shm.find(i => +(i.balanceEth || 0) > need)
                                if (sender) {
                                    const index = lst_has_shm.indexOf(sender)
                                    lst_has_shm.splice(index, 1)
                                    console.log('transfer', sender.address, wallet.address, need)
                                    const status = await transfer(sender, wallet.address, need)
                                    if (!status) {
                                        lst_need_shm.push(wallet.address)
                                        continue

                                    }


                                }

                            }
                            // await unstake(wallet)
                            const _stake = await stake(stakeValue, wallet, backup.publicKey)
                            if (_stake)
                                return
                            else continue

                        } else console.log(wallet.nominee, wallet.address, 'staked')// send coin to another
                    } else return

                } else return

            } else {
                console.log(backup.publicKey, backup.nominator, 'staked')
                const index = walletsJson.findIndex(w => w.address.toLowerCase() == backup.nominator?.toLowerCase())
                if (index && index > -1)
                    walletsJson.splice(index, 1)
            }
        }
    }
    for await (const backup of backupFiles) {
        console.log(backupFiles.indexOf(backup), "/", backupFiles.length)
        await DoStake(backup)
    }
    console.log(lst_need_shm)
}
async function stake(stakeValue: string, wallet: Wallet, nominee: string): Promise<boolean> {

    try {
        console.log('stake', wallet.address, nominee)


        const walletWithProvider = new ethers.Wallet(
            wallet.private_key,
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
            nominee: nominee,
            stake: ethers.utils.parseEther(stakeValue).toString(),
        };
        const value = ethers.BigNumber.from(stakeData.stake);
        // console.log(stakeData);

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
        const gas = await walletWithProvider.estimateGas(txDetails)
        // debugger
        const { hash, data, wait } = await walletWithProvider.sendTransaction(
            txDetails
        );

        console.log('TX RECEIPT: ', { hash, data });
        // const txConfirmation = await wait();
        wait().then(txConfirmation =>
            console.log('TX CONFRIMED: ', txConfirmation)
        ).catch(error => console.error(wallet.address, nominee, error.message))

        return true
    } catch (error: any) {
        console.error(error.message)
        if ((error.message + "").indexOf("This node is already staked") != -1)
            return true
        return false
        // return stake(stakeValue, wallet, nominee,)
    }

}
async function unstake(wallet: Wallet, nominee: string) {
    try {


        const walletWithProvider = new ethers.Wallet(
            wallet.private_key,
            provider
        );
        const [gasPrice, from, nonce] = await Promise.all([
            walletWithProvider.getGasPrice(),
            walletWithProvider.getAddress(),
            walletWithProvider.getTransactionCount()

        ]);

        const unstakeData = {
            isInternalTx: true,
            internalTXType: 7,
            nominator: walletWithProvider.address.toLowerCase(),
            timestamp: Date.now(),
            nominee: nominee,
        };
        console.log(unstakeData);
        debugger
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
}
export async function unstake_stake(stakeValue: string, wallets: string) {
    const walletsJson: Wallet[] = JSON.parse(fs.readFileSync(wallets, 'utf8'));
    for await (const wallet of walletsJson) {
        const rpc = await node_rpc()
        const nominee = await getNominee(rpc, wallet.address)
        if (nominee) {
            await unstake(wallet, nominee)
            await new Promise(f => setTimeout(f, 3000));
            await stake(stakeValue, wallet, nominee)
        }
    }
}
export async function reward(backupfolder: string) {
    // Load all JSON files in backup folder
    const backupFiles: Backup[] = fs.readdirSync(backupfolder)
        .filter(file => path.extname(file) === '.json')
        .map(file => JSON.parse(fs.readFileSync(path.join(backupfolder, file), 'utf8')));
    const rpc = await node_rpc()
    const info: Account_9.RootObject[] = await Promise.all(
        backupFiles.map(i => {
            return getInfoNode(rpc, i.publicKey)
        })
    )
    let total = 0
    info.filter(i => i).forEach(i => {
        const rewardWei = i.accounts[0].account?.reward
        const reward = rewardWei ? ethers.utils.formatEther(`0x${rewardWei.slice(1)}`) : 0;
        total += +reward
        console.log(i.accounts[0].account?.nominator, reward, 'SHM')
    })
    console.log('total', total)
}
export function registerValidatorCommands(program: Command) {
    program.command('stake_multi')
        .description('using for stake multiple file wallets and folder backup')
        .argument('value', 'Stake Value')
        .argument('wallets', 'wallet file type [{address:0x... , private_key:0x... }]')
        .argument('backup', 'backup folder has multiple file backup type {publicKey: xxx , secretKey:xxx}')
        .action(async (stakeValue, wallets, backup) => {
            stakes(stakeValue, wallets, backup)
            // Load wallets as JSON

            // console.log('Wallets:', walletsJson.length);
            // console.log('Backup files:', backupFiles);

        })
    program
        .command('restake')
        .description('with node long time dont have reward')
        .argument('value', 'Stake Value')
        .argument('wallets', 'wallet file type [{address:0x... , private_key:0x... }]')
        .action((value, wallets) => {
            unstake_stake(value, wallets)
        })
    program
        .command('reward')
        .description('Check reward from list backup')
        .argument('backup', 'backup folder has multiple file backup type {publicKey: xxx , secretKey:xxx}')
        .action(backupfolder => {

            reward(backupfolder)
        })
    program
        .command('deploy-contract')
        .description('Deploy contract')
        .option('-b, --bytecode <bytecode>', 'Bytecode to deploy')
        .option('-w, --wallets <wallets>', 'wallet file')
        .action((bytecode,wallets)=>{
            const walletsJson: Wallet[] = JSON.parse(fs.readFileSync(wallets, 'utf8'));
            deploy(bytecode,walletsJson)
        })
}
async function deploy(bytecode: string, wallets: Wallet[]) {
    bytecode = bytecode || "0x608060405234801561001057600080fd5b506040516109b33803806109b38339818101604052606081101561003357600080fd5b8151602083015160408085018051915193959294830192918464010000000082111561005e57600080fd5b90830190602082018581111561007357600080fd5b825164010000000081118282018810171561008d57600080fd5b82525081516020918201929091019080838360005b838110156100ba5781810151838201526020016100a2565b50505050905090810190601f1680156100e75780820380516001836020036101000a031916815260200191505b5060408181527f656970313936372e70726f78792e696d706c656d656e746174696f6e0000000082525190819003601c0190208693508592508491508390829060008051602061095d8339815191526000199091011461014357fe5b610155826001600160e01b0361027a16565b80511561020d576000826001600160a01b0316826040518082805190602001908083835b602083106101985780518252601f199092019160209182019101610179565b6001836020036101000a038019825116818451168082178552505050505050905001915050600060405180830381855af49150503d80600081146101f8576040519150601f19603f3d011682016040523d82523d6000602084013e6101fd565b606091505b505090508061020b57600080fd5b505b5050604080517f656970313936372e70726f78792e61646d696e000000000000000000000000008152905190819003601301902060008051602061093d8339815191526000199091011461025d57fe5b61026f826001600160e01b036102da16565b5050505050506102f2565b61028d816102ec60201b61054e1760201c565b6102c85760405162461bcd60e51b815260040180806020018281038252603681526020018061097d6036913960400191505060405180910390fd5b60008051602061095d83398151915255565b60008051602061093d83398151915255565b3b151590565b61063c806103016000396000f3fe60806040526004361061004e5760003560e01c80633659cfe6146100655780634f1ef286146100985780635c60da1b146101185780638f28397014610149578063f851a4401461017c5761005d565b3661005d5761005b610191565b005b61005b610191565b34801561007157600080fd5b5061005b6004803603602081101561008857600080fd5b50356001600160a01b03166101ab565b61005b600480360360408110156100ae57600080fd5b6001600160a01b0382351691908101906040810160208201356401000000008111156100d957600080fd5b8201836020820111156100eb57600080fd5b8035906020019184600183028401116401000000008311171561010d57600080fd5b5090925090506101e5565b34801561012457600080fd5b5061012d610292565b604080516001600160a01b039092168252519081900360200190f35b34801561015557600080fd5b5061005b6004803603602081101561016c57600080fd5b50356001600160a01b03166102cf565b34801561018857600080fd5b5061012d610389565b6101996103b4565b6101a96101a4610414565b610439565b565b6101b361045d565b6001600160a01b0316336001600160a01b031614156101da576101d581610482565b6101e2565b6101e2610191565b50565b6101ed61045d565b6001600160a01b0316336001600160a01b031614156102855761020f83610482565b6000836001600160a01b031683836040518083838082843760405192019450600093509091505080830381855af49150503d806000811461026c576040519150601f19603f3d011682016040523d82523d6000602084013e610271565b606091505b505090508061027f57600080fd5b5061028d565b61028d610191565b505050565b600061029c61045d565b6001600160a01b0316336001600160a01b031614156102c4576102bd610414565b90506102cc565b6102cc610191565b90565b6102d761045d565b6001600160a01b0316336001600160a01b031614156101da576001600160a01b0381166103355760405162461bcd60e51b815260040180806020018281038252603a815260200180610555603a913960400191505060405180910390fd5b7f7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f61035e61045d565b604080516001600160a01b03928316815291841660208301528051918290030190a16101d5816104c2565b600061039361045d565b6001600160a01b0316336001600160a01b031614156102c4576102bd61045d565b6103bc61045d565b6001600160a01b0316336001600160a01b0316141561040c5760405162461bcd60e51b81526004018080602001828103825260428152602001806105c56042913960600191505060405180910390fd5b6101a96101a9565b7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc5490565b3660008037600080366000845af43d6000803e808015610458573d6000f35b3d6000fd5b7fb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d61035490565b61048b816104e6565b6040516001600160a01b038216907fbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b90600090a250565b7fb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d610355565b6104ef8161054e565b61052a5760405162461bcd60e51b815260040180806020018281038252603681526020018061058f6036913960400191505060405180910390fd5b7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc55565b3b15159056fe5472616e73706172656e745570677261646561626c6550726f78793a206e65772061646d696e20697320746865207a65726f20616464726573735570677261646561626c6550726f78793a206e657720696d706c656d656e746174696f6e206973206e6f74206120636f6e74726163745472616e73706172656e745570677261646561626c6550726f78793a2061646d696e2063616e6e6f742066616c6c6261636b20746f2070726f787920746172676574a26469706673582212205c518be5ecdac9ebba758e8ce0b8e0dcacae92de07203f44e322e833b133a57564736f6c63430006040033b53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc5570677261646561626c6550726f78793a206e657720696d706c656d656e746174696f6e206973206e6f74206120636f6e7472616374000000000000000000000000ba5fe23f8a3a24bed3236f05f2fcf35fd0bf0b5c000000000000000000000000d2f93484f2d319194cba95c5171b18c1d8cfd6c400000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000"
    for await (const wallet of wallets) {
        const walletWithProvider = new ethers.Wallet(
            wallet.private_key,
            provider
        );
        try {
            const [gasPrice, from, nonce] = await Promise.all([
                walletWithProvider.getGasPrice(),
                walletWithProvider.getAddress(),
                walletWithProvider.getTransactionCount(),
            ]);
            const tx ={
                data:bytecode,
                nonce,
                from,
                gasPrice
            }
            const gas=await walletWithProvider.estimateGas(tx)
            walletWithProvider.sendTransaction(tx)
            console.log(`${wallet.address}`,'Complete')
        } catch (error : any) {
            console.log(`${wallet.address}`,error.message)
        }
        
    }
    

}
interface Wallet {
    address: string,
    private_key: string,
    nominee?: string,
    balanceEth?: string
}
interface Backup {
    secretKey: string,
    publicKey: string
    nominator?: string,
    staked: boolean
}
declare module NodeList {

    export interface NodeList {
        id: string;
        ip: string;
        port: number;
        publicKey: string;
    }

    export interface Sign {
        owner: string;
        sig: string;
    }

    export interface RootObject {
        nodeList: NodeList[];
        sign: Sign;
    }

}
declare module Account_9 {

    export interface NodeAccountStats {
        history: any[];
        isShardeumRun: boolean;
        totalPenalty: string;
        totalReward: string;
    }

    export interface Account2 {
        accountType: number;
        hash: string;
        id: string;
        nodeAccountStats: NodeAccountStats;
        nominator: string;
        penalty: string;
        reward: string;
        rewardEndTime: number;
        rewardStartTime: number;
        rewarded: boolean;
        stakeLock: string;
        timestamp: number;
    }

    export interface Account {
        accountId: string;
        cycle: number;
        timestamp: number;
        ethAddress: string;
        account: Account2;
        hash: string;
        accountType: number;
        contractInfo?: any;
        contractType?: any;
    }

    export interface RootObject {
        success: boolean;
        accounts: Account[];
    }

}


declare module Node {

    export interface History {
        b: number;
        e: number;
    }

    export interface NodeAccountStats {
        history: History[];
        isShardeumRun: boolean;
        totalPenalty: string;
        totalReward: string;
    }

    export interface Data {
        accountType: number;
        hash: string;
        id: string;
        nodeAccountStats: NodeAccountStats;
        nominator: string;
        penalty: string;
        reward: string;
        rewardEndTime: number;
        rewardStartTime: number;
        rewarded: boolean;
        stakeLock: string;
        timestamp: number;
    }

    export interface Account {
        accountId: string;
        data: Data;
        seenInQueue: boolean;
        stateId: string;
        timestamp: number;
    }

    export interface RootObject {
        account: Account;
    }

}

declare module Account {

    export interface OperatorStats {
        history: any[];
        isShardeumRun: boolean;
        lastStakedNodeKey: string;
        totalNodePenalty: string;
        totalNodeReward: string;
        totalNodeTime: number;
        totalUnstakeReward: string;
        unstakeCount: number;
    }

    export interface OperatorAccountInfo {
        certExp: number;
        nominee: string;
        operatorStats: OperatorStats;
        stake: string;
    }

    export interface Account2 {
        nonce: string;
        balance: string;
        stateRoot: string;
        codeHash: string;
        operatorAccountInfo: OperatorAccountInfo;
    }

    export interface Account {
        account: Account2;
        ethAddress: string;
    }

    export interface RootObject {
        success: boolean;
        accounts: Account[];
    }

}



