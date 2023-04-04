import { ethers } from 'ethers';
import { reward, stakes, unstake_stake } from './validator-commands'
// const validator from ''
// console.log('test',new Date)
// console.log(
    // reward('../shardeum/backup')
// )
const rs= stakes('10.1','../shardeum/wallets.json','../shardeum/backup').then(console.log).catch(console.error)
// const testbalance=async ()=>{
//     const provider = new ethers.providers.JsonRpcProvider({
//         url: `http://localhost:9002`,
//     }
//     );
//     const balance = await provider.getBalance('0x0486509810A2dC4c44D4Dc71BE8B97413657cB1f')
//     console.log(balance)
// }
// testbalance()
// unstake_stake('10.1','../shardeum/wallet.json')
