const { BRIDGE_VALIDATORS_ABI, HOME_AMB_ABI } = require('commons')

const path = require('path')
require('dotenv').config()
const Web3 = require('web3')
const fetch = require('node-fetch')
const { URL } = require('url')

const fs = require('fs')

const {
  COMMON_HOME_RPC_URL,
  COMMON_HOME_BRIDGE_ADDRESS,
  COMMON_FOREIGN_RPC_URL,
  COMMON_FOREIGN_BRIDGE_ADDRESS,
  ALM_FOREIGN_EXPLORER_API,
  ALM_HOME_EXPLORER_API
} = process.env

const STARTING_PAGING_SIZE = 10_000_000

const generateSnapshot = async (side, url, bridgeAddress) => {
  const snapshotPath = `../src/snapshots/${side}.json`
  const snapshotFullPath = path.join(__dirname, snapshotPath)
  const snapshot = {}

  const web3 = new Web3(new Web3.providers.HttpProvider(url))
  const api = side === 'home' ? ALM_HOME_EXPLORER_API : ALM_FOREIGN_EXPLORER_API

  const getPastEventsWithFallback = async (contract, eventName, options, pagingSize = STARTING_PAGING_SIZE) =>
    contract.getPastEvents(eventName, options).catch(async e => {
      if (e.message.includes('block range') || e.message.includes('timeout')) {
        const abi = contract.options.jsonInterface.find(abi => abi.type === 'event' && abi.name === eventName)

        const originalToBlock = options.toBlock
        options.toBlock = Math.min(options.toBlock, options.fromBlock + pagingSize - 1)
        const pastEvents = []

        while (options.fromBlock !== originalToBlock) {
          const url = new URL(api)
          url.searchParams.append('module', 'logs')
          url.searchParams.append('action', 'getLogs')
          url.searchParams.append('address', contract.options.address)
          url.searchParams.append('fromBlock', options.fromBlock)
          url.searchParams.append('toBlock', options.toBlock || 'latest')
          url.searchParams.append('topic0', web3.eth.abi.encodeEventSignature(abi))
          let logs
          try {
            const fetchRes = await fetch(url)
            logs = await fetchRes.json()
          } catch (err) {
            if (err.message.includes('canceled due to enabled timeout') || err.message.includes('Unexpected token <')) {
              logs = await getPastEventsWithFallback(contract, eventName, options, pagingSize / 2)
            } else {
              throw err
            }
          }
          const res = logs.result.map(log => ({
            transactionHash: log.transactionHash,
            blockNumber: parseInt(log.blockNumber.slice(2), 16),
            returnValues: web3.eth.abi.decodeLog(abi.inputs, log.data, log.topics.slice(1))
          }))
          pastEvents.push(...res)

          options.fromBlock = Math.min(options.toBlock + 1, originalToBlock)
          options.toBlock = Math.min(options.fromBlock + pagingSize - 1, originalToBlock)
        }
        return pastEvents
      }
      throw e
    })

  const currentBlockNumber = await web3.eth.getBlockNumber()
  snapshot.snapshotBlockNumber = currentBlockNumber

  // Save chainId
  snapshot.chainId = await web3.eth.getChainId()

  const bridgeContract = new web3.eth.Contract(HOME_AMB_ABI, bridgeAddress)

  // Save RequiredBlockConfirmationChanged events
  let requiredBlockConfirmationChangedEvents = await getPastEventsWithFallback(
    bridgeContract,
    'RequiredBlockConfirmationChanged',
    {
      fromBlock: 0,
      toBlock: currentBlockNumber
    }
  )

  // In case RequiredBlockConfirmationChanged was not emitted during initialization in early versions of AMB
  // manually generate an event for this. Example Sokol - Kovan bridge
  if (requiredBlockConfirmationChangedEvents.length === 0) {
    const deployedAtBlock = await bridgeContract.methods.deployedAtBlock().call()
    const blockConfirmations = await bridgeContract.methods.requiredBlockConfirmations().call()

    requiredBlockConfirmationChangedEvents.push({
      blockNumber: parseInt(deployedAtBlock),
      returnValues: {
        requiredBlockConfirmations: blockConfirmations
      }
    })
  }

  snapshot.RequiredBlockConfirmationChanged = requiredBlockConfirmationChangedEvents.map(e => ({
    blockNumber: e.blockNumber,
    returnValues: {
      requiredBlockConfirmations: e.returnValues.requiredBlockConfirmations
    }
  }))

  const validatorAddress = await bridgeContract.methods.validatorContract().call()
  const validatorContract = new web3.eth.Contract(BRIDGE_VALIDATORS_ABI, validatorAddress)

  // Save RequiredSignaturesChanged events
  const RequiredSignaturesChangedEvents = await getPastEventsWithFallback(
    validatorContract,
    'RequiredSignaturesChanged',
    {
      fromBlock: 0,
      toBlock: currentBlockNumber
    }
  )
  snapshot.RequiredSignaturesChanged = RequiredSignaturesChangedEvents.map(e => ({
    blockNumber: e.blockNumber,
    returnValues: {
      requiredSignatures: e.returnValues.requiredSignatures
    }
  }))

  // Save ValidatorAdded events
  const validatorAddedEvents = await getPastEventsWithFallback(validatorContract, 'ValidatorAdded', {
    fromBlock: 0,
    toBlock: currentBlockNumber
  })

  snapshot.ValidatorAdded = validatorAddedEvents.map(e => ({
    blockNumber: e.blockNumber,
    returnValues: {
      validator: e.returnValues.validator
    },
    event: 'ValidatorAdded'
  }))

  // Save ValidatorRemoved events
  const validatorRemovedEvents = await getPastEventsWithFallback(validatorContract, 'ValidatorRemoved', {
    fromBlock: 0,
    toBlock: currentBlockNumber
  })

  snapshot.ValidatorRemoved = validatorRemovedEvents.map(e => ({
    blockNumber: e.blockNumber,
    returnValues: {
      validator: e.returnValues.validator
    },
    event: 'ValidatorRemoved'
  }))

  // Write snapshot
  fs.writeFileSync(snapshotFullPath, JSON.stringify(snapshot, null, 2))
}

const main = async () => {
  await Promise.all([
    generateSnapshot('home', COMMON_HOME_RPC_URL, COMMON_HOME_BRIDGE_ADDRESS),
    generateSnapshot('foreign', COMMON_FOREIGN_RPC_URL, COMMON_FOREIGN_BRIDGE_ADDRESS)
  ])
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.log('Error while creating snapshots')
    console.error(error)
    process.exit(0)
  })
