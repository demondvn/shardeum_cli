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
        const [nonce,gasPrice] = await Promise.all([
            walletWithProvider.getTransactionCount(from.address),
            walletWithProvider.getGasPrice()
        ]) 
        
        const status = await walletWithProvider.sendTransaction({
            to,
            value: ethers.utils.parseEther(value + ""),
            gasPrice ,
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
    const lst_need_shm :string[]=[]
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
                                const need = minvalue - balance + 1
                                const sender = lst_has_shm.find(i => +(i.balanceEth || 0) > need)
                                if (sender){
                                    const index = lst_has_shm.indexOf(sender)
                                    lst_has_shm.splice(index,1)
                                    console.log('transfer',sender.address,wallet.address,need)
                                    const status= await transfer(sender, wallet.address, need)
                                    if(!status){
                                        lst_need_shm.push(wallet.address)
                                        continue
                                     
                                    }
                                  
                                        
                                }
                                    
                            }
                            await stake(stakeValue, wallet, backup.publicKey)
                            await get_nominator(backup)

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
        console.log(backupFiles.indexOf(backup),"/",backupFiles.length)
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
    } catch (error) {
        console.error(error)
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



