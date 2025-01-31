import { defaultConfig } from "../config/defaultConfig";
import {Address, Cell, Message, Transaction, ContractProvider, Contract, Sender, toNano} from "ton-core";
import {Executor} from "../executor/Executor";
import {BlockchainStorage, LocalBlockchainStorage} from "./BlockchainStorage";
import { extractEvents, Event } from "../event/Event";
import { BlockchainContractProvider } from "./BlockchainContractProvider";
import { BlockchainSender } from "./BlockchainSender";
import { testKey } from "../utils/testKey";
import { TreasuryContract } from "../treasury/Treasury";
import { Verbosity } from "./SmartContract";

const LT_ALIGN = 1000000n

export type SendMessageResult = {
    transactions: Transaction[],
    events: Event[],
}

export type OpenedContract<F> = {
    [P in keyof F]: P extends `get${string}`
        ? (F[P] extends (x: ContractProvider, ...args: infer P) => infer R ? (...args: P) => R : never)
        : (P extends `send${string}`
            ? (F[P] extends (x: ContractProvider, ...args: infer P) => infer R ? (...args: P) => Promise<SendMessageResult & {
                result: R extends Promise<infer PR> ? PR : R
            }> : never)
            : F[P]);
}

export class Blockchain {
    storage: BlockchainStorage
    private networkConfig: Cell
    #lt = 0n;
    readonly executor: Executor
    readonly messageQueue: Message[] = []
    #verbosity: Verbosity = 'none'

    get lt() {
        return this.#lt
    }

    private constructor(opts: { executor: Executor, config?: Cell, storage: BlockchainStorage }) {
        this.networkConfig = opts.config ?? Cell.fromBoc(Buffer.from(defaultConfig, 'base64'))[0]
        this.executor = opts?.executor
        this.storage = opts.storage
    }

    get config(): Cell {
        return this.networkConfig
    }

    async sendMessage(message: Message): Promise<SendMessageResult> {
        this.pushMessage(message)
        return await this.runQueue()
    }

    pushMessage(message: Message) {
        if (message.info.type === 'external-out') {
            throw new Error('Cant send external out message')
        }
        this.messageQueue.push(message)
    }

    async runQueue(): Promise<SendMessageResult>  {
        const txes = await this.processQueue()
        return {
            transactions: txes,
            events: txes.map(tx => extractEvents(tx)).flat(),
        }
    }

    async processQueue() {
        let result: Transaction[] = []

        while (this.messageQueue.length > 0) {
            let message = this.messageQueue.shift()!

            if (message.info.type === 'external-out') {
                continue
            }

            this.#lt += LT_ALIGN
            let transaction = await (await this.getContract(message.info.dest)).receiveMessage(message)

            result.push(transaction)

            for (let message of transaction.outMessages.values()) {
                this.messageQueue.push(message)
            }
        }

        return result
    }

    provider(address: Address, init?: { code: Cell, data: Cell }): ContractProvider {
        return new BlockchainContractProvider(this, address, init)
    }

    sender(address: Address): Sender {
        return new BlockchainSender(this, address)
    }

    async treasury(seed: string, workchain: number = 0) {
        let key = testKey(seed)
        let treasury = TreasuryContract.create(workchain, key)
        let wallet = this.openContract(treasury)

        const contract = await this.getContract(treasury.address)
        if (contract.balance === 0n) {
            contract.balance = toNano(1_000_000)
        }

        return wallet
    }

    openContract<T extends Contract>(contract: T) {
        let address: Address;
        let init: { code: Cell, data: Cell } | undefined = undefined;

        if (!Address.isAddress(contract.address)) {
            throw Error('Invalid address');
        }
        address = contract.address;
        if (contract.init) {
            if (!(contract.init.code instanceof Cell)) {
                throw Error('Invalid init.code');
            }
            if (!(contract.init.data instanceof Cell)) {
                throw Error('Invalid init.data');
            }
            init = contract.init;
        }

        const provider = this.provider(address, init)
        const blkch = this

        return new Proxy<any>(contract as any, {
            get(target, prop) {
                const value = target[prop]
                if (typeof prop === 'string' && typeof value === 'function') {
                    if (prop.startsWith('get')) {
                        return (...args: any[]) => value.apply(target, [provider, ...args])
                    } else if (prop.startsWith('send')) {
                        return async (...args: any[]) => {
                            const ret = value.apply(target, [provider, ...args])
                            if (ret instanceof Promise) {
                                const r = await ret
                                return {
                                    ...await blkch.runQueue(),
                                    result: r,
                                }
                            } else {
                                return {
                                    ...await blkch.runQueue(),
                                    result: ret,
                                }
                            }
                        }
                    }
                }
                return value
            }
        }) as OpenedContract<T>;
    }

    async getContract(address: Address) {
        return await this.storage.getContract(this, address)
    }

    get verbosity() {
        return this.#verbosity
    }

    set verbosity(value: Verbosity) {
        this.#verbosity = value
    }

    async setVerbosityForAddress(address: Address, verbosity: Verbosity) {
        const contract = await this.getContract(address)
        contract.verbosity = verbosity
    }

    async resetVerbosityForAddress(address: Address) {
        const contract = await this.getContract(address)
        contract.resetVerbosity()
    }

    setConfig(config: Cell) {
        this.networkConfig = config
    }

    static async create(opts?: { config?: Cell, storage?: BlockchainStorage }) {
        return new Blockchain({
            executor: await Executor.create(),
            storage: opts?.storage ?? new LocalBlockchainStorage(),
            ...opts
        })
    }
}