import { stakes, unstake_stake } from './validator-commands'
// const validator from ''
console.log('test',new Date)

const rs= stakes('10.1','../shardeum/wallets.json','../shardeum/backup').then(console.log).catch(console.error)
// unstake_stake('10.1','../shardeum/wallet.json')
