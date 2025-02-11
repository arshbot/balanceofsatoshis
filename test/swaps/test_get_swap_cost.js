const {test} = require('tap');

const {getSwapCost} = require('./../../swaps');

const makeQuote = ({max, min}) => ({
  cltv_delta: 1,
  max_swap_amount: max || 1,
  min_swap_amount: min || 1,
  prepay_amt: 1,
  swap_fee_base: 1,
  swap_fee_rate: 1,
  swap_payment_dest: Buffer.alloc(33).toString('hex'),
});

const tests = [
  {
    args: {},
    description: 'Swap service is required',
    error: [400, 'ExpectedSwapServiceToGetSwapCost'],
  },
  {
    args: {service: {}},
    description: 'Tokens are required',
    error: [400, 'ExpectedTokensCountToGetSwapCost'],
  },
  {
    args: {service: {}, tokens: 1},
    description: 'Swap type is required',
    error: [400, 'GotUnexpectedSwapTypeWhenGettingSwapCost'],
  },
  {
    args: {service: {}, tokens: 1, type: 'type'},
    description: 'Known swap type is required',
    error: [400, 'GotUnexpectedSwapTypeWhenGettingSwapCost'],
  },
  {
    args: {
      service: {loopInQuote: ({}, cbk) => cbk(null, makeQuote({}))},
      tokens: 1e6,
      type: 'inbound',
    },
    description: 'Amount must be under maximum',
    error: [400, 'AmountExceedsMaximum', {max: 1}],
  },
  {
    args: {
      service: {
        loopOutQuote: ({}, cbk) => cbk(null, makeQuote({max: 1e7, min: 1e6})),
      },
      tokens: 1e5,
      type: 'outbound',
    },
    description: 'Amount must be over minimum',
    error: [400, 'AmountBelowMinimumSwap', {min: 1e6}],
  },
  {
    args: {
      service: {loopInQuote: ({}, cbk) => cbk(null, makeQuote({max: 1e7}))},
      tokens: 1e6,
      type: 'inbound',
    },
    description: 'Amount must be under maximum',
    expected: {cost: 2},
  },
];

tests.forEach(({args, description, error, expected}) => {
  return test(description, async ({end, equal, rejects}) => {
    if (!!error) {
      rejects(getSwapCost(args), error, 'Got expected error');
    } else {
      equal((await getSwapCost(args)).cost, expected.cost, 'Got cost');
    }

    return end();
  });
});
