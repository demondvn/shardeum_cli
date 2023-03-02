import axios from 'axios';
import { Command } from 'commander';
import { Account } from 'ethereumjs-util';
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
    const url = `http://${rpc}/account/${address}`
    const res = await axios.get(url)
    const root = res.data as Account.RootObject
    return root.account?.operatorAccountInfo?.nominee
}
async function getNominator(rpc: string, address: string) {
    const url = `http://${rpc}/account/${address}?type=9`
    const res = await axios.get(url)
    const root = res.data as Node.RootObject
    return root.account?.data?.nominator
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
        const status = await walletWithProvider.sendTransaction({
            to,
            value: ethers.utils.parseEther(value + ""),
            gasPrice: await walletWithProvider.getGasPrice(),
            gasLimit: 30000,
            from: from.address,
            nonce: await walletWithProvider.getTransactionCount(from.address)
        })
        console.log(status)
    } catch (error) {
        console.error(error)
    }

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
    }
    const get_nominator = async (backup: Backup) => {
        const nominator = await getNominator(rpc, backup.publicKey)
        backup.nominator = nominator
    }
    await Promise.all(
        walletsJson.map(i => get_nominee(i)))

    await Promise.all(
        backupFiles.map(i => get_nominator(i))
    )
    const lst_backup_valid = backupFiles.filter(i => !i.nominator)
    const lst_wallet_valid = walletsJson.filter(i => !i.nominee)
    const lst_wallet_not_valid_has_money = walletsJson.filter(i => i.nominee && +(i.balanceEth || 0) > 10)

    const minvalue = (+stakeValue + 0.5)
    for await (const backup of lst_backup_valid) {
        const wallet = lst_wallet_valid.pop()
        if (!wallet)
            continue
        if (+(wallet?.balanceEth || 0) < minvalue) {
            const sender = lst_wallet_not_valid_has_money.pop() as Wallet
            if(sender){
                console.log('send', minvalue, sender.address, wallet?.address)
                await transfer(sender, wallet.address, minvalue)
                
            }
            const balance = await getBalanceEth(wallet.address)
            if (+balance < minvalue) {
                continue
            }
        }
        stake(stakeValue, wallet, backup.publicKey)

        // if (status)
            // await new Promise(f => setTimeout(f, 3000));
    }

}
async function stake(stakeValue: string, wallet: Wallet, nominee: string) {
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
        // debugger
        const { hash, data, wait } = await walletWithProvider.sendTransaction(
            txDetails
        );

        console.log('TX RECEIPT: ', { hash, data });
        // const txConfirmation = await wait();
        wait().then(txConfirmation=>
            console.log('TX CONFRIMED: ', txConfirmation)
        ).catch(console.error)
        
        return true
    } catch (error) {
        console.error(error)
    }
    return false
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
    nominator?: string
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

    export interface History {
        b: number;
        e: number;
    }

    export interface OperatorStats {
        history: History[];
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

    export interface Account {
        nonce: string;
        balance: string;
        stateRoot: string;
        codeHash: string;
        operatorAccountInfo: OperatorAccountInfo;
    }

    export interface RootObject {
        account: Account;
    }

}

