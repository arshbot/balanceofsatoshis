const asyncAuto = require('async/auto');
const {decodePaymentRequest} = require('ln-service');
const {getChannels} = require('ln-service');
const {getRoutes} = require('ln-service');
const {getWalletInfo} = require('ln-service');
const {payViaRoutes} = require('ln-service');
const {returnResult} = require('asyncjs-util');

const {authenticatedLnd} = require('./../lnd');
const executeProbe = require('./execute_probe');
const {findMaxRoutable} = require('./../routing');
const {getInboundPath} = require('./../routing');
const {sortBy} = require('./../arrays');

const cltvBuffer = 3;
const defaultCltvDelta = 144;
const defaultMaxFee = 1337;
const defaultTokens = 10;
const {floor} = Math;
const {isArray} = Array;
const maxCltvDelta = 144 * 30;
const {now} = Date;
const reserveRatio = 0.01;

/** Determine if a destination can be paid by probing it

  {
    [destination]: <Destination Public Key Hex String>
    [find_max]: <Find Maximum Payable On Probed Route Below Tokens Number>
    [ignore]: [{
      from_public_key: <Avoid Node With Public Key Hex String>
    }]
    [in_through]: <Pay In Through Public Key Hex String>
    [is_real_payment]: <Pay the Request after Probing Bool> // default: false
    [is_strict_max_fee]: <Avoid Probing Too-High Fee Routes Bool>
    logger: <Winston Logger Object>
    [max_fee]: <Maximum Fee Tokens Number>
    [node]: <Node Name String>
    [out_through]: <Out through peer with Public Key Hex String>
    [request]: <Payment Request String>
    [tokens]: <Tokens Number>
  }

  @returns via cbk
  {
    [fee]: <Fee Tokens To Destination Number>
    [latency_ms]: <Latency Milliseconds Number>
    [route_maximum]: <Maximum Sendable Tokens On Successful Probe Path Number>
    [paid]: <Paid Tokens Number>
    [preimage]: <Payment HTLC Preimage Hex String>
    [success]: [<Standard Format Channel Id String>]
  }
*/
module.exports = (args, cbk) => {
  return asyncAuto({
    // Lnd
    getLnd: cbk => authenticatedLnd({node: args.node}, cbk),

    // Get height
    getHeight: ['getLnd', ({getLnd}, cbk) => {
      return getWalletInfo({lnd: getLnd.lnd}, cbk);
    }],

    // Destination to pay
    to: ['getLnd', ({getLnd}, cbk) => {
      if (!!args.destination) {
        return cbk(null, {destination: args.destination, routes: []});
      }

      if (!args.request) {
        return cbk([400, 'PayRequestOrDestinationRequiredToInitiateProbe']);
      }

      return decodePaymentRequest({
        lnd: getLnd.lnd,
        request: args.request,
      },
      cbk);
    }],

    // Get channels to determine an outgoing channel id restriction
    getChannels: ['getLnd', ({getLnd}, cbk) => {
      // Exit early when there is no need to add an outgoing channel id
      if (!args.out_through) {
        return cbk();
      }

      return getChannels({lnd: getLnd.lnd}, cbk);
    }],

    // Tokens
    tokens: ['to', ({to}, cbk) => {
      return cbk(null, args.tokens || to.tokens || defaultTokens);
    }],

    // Get inbound path if an inbound restriction is specified
    getInboundPath: ['getLnd', 'to', 'tokens', ({getLnd, to, tokens}, cbk) => {
      if (!args.in_through) {
        return cbk();
      }

      return getInboundPath({
        tokens,
        destination: to.destination,
        lnd: getLnd.lnd,
        through: args.in_through,
      },
      (err, res) => {
        if (!!err) {
          return cbk(err);
        }

        return cbk(null, [res.path]);
      });
    }],

    // Outgoing channel id
    outgoingChannelId: ['getChannels', 'to', ({getChannels, to}, cbk) => {
      if (!getChannels) {
        return cbk();
      }

      const {channels} = getChannels;
      const outPeer = args.out_through;
      const tokens = args.tokens || to.tokens || defaultTokens;

      const withPeer = channels
        .filter(n => !!n.is_active)
        .filter(n => n.partner_public_key === outPeer);

      if (!withPeer.length) {
        return cbk([404, 'NoActiveChannelWithOutgoingPeer']);
      }

      const withBalance = withPeer.filter(n => {
        const reserve = n.local_reserve || floor(n.capacity * reserveRatio);

        return n.local_balance - tokens > reserve + n.commit_transaction_fee;
      });

      if (!withBalance.length) {
        return cbk([404, 'NoChannelWithSufficientBalance']);
      }

      const attribute = 'local_balance';

      const [channel] = sortBy({attribute, array: withBalance}).sorted;

      return cbk(null, channel.id);
    }],

    // Check that there is a potential path
    checkPath: [
      'getInboundPath',
      'getLnd',
      'outgoingChannelId',
      'to',
      'tokens',
      ({getInboundPath, getLnd, outgoingChannelId, to, tokens}, cbk) =>
    {
      return getRoutes({
        tokens,
        cltv_delta: to.cltv_delta,
        destination: to.destination,
        ignore: args.ignore,
        is_adjusted_for_past_failures: true,
        is_strict_hints: !!getInboundPath,
        lnd: getLnd.lnd,
        outgoing_channel: outgoingChannelId,
        routes: getInboundPath || to.routes,
      },
      (err, res) => {
        if (!!err) {
          return cbk(err);
        }

        if (!res.routes.length) {
          return cbk([404, 'FailedToFindPathToDestination']);
        }

        return cbk();
      });
    }],

    // Probe towards destination
    probe: [
      'getHeight',
      'getInboundPath',
      'getLnd',
      'outgoingChannelId',
      'to',
      ({getHeight, getInboundPath, getLnd, outgoingChannelId, to}, cbk) =>
    {
      return executeProbe({
        cltv_delta: (to.cltv_delta || defaultCltvDelta) + cltvBuffer,
        destination: to.destination,
        ignore: args.ignore,
        is_strict_hints: !!getInboundPath,
        is_strict_max_fee: args.is_strict_max_fee,
        lnd: getLnd.lnd,
        logger: args.logger,
        max_fee: args.max_fee,
        max_timeout_height: getHeight.current_block_height + maxCltvDelta,
        outgoing_channel: outgoingChannelId,
        routes: getInboundPath || to.routes,
        tokens: args.tokens || to.tokens || defaultTokens,
      },
      cbk);
    }],

    // Get maximum value of the successful route
    getMax: ['getLnd', 'probe', 'to', ({getLnd, probe, to}, cbk) => {
      if (!args.find_max || !probe.route) {
        return cbk();
      }

      return findMaxRoutable({
        cltv: to.cltv_delta || defaultCltvDelta,
        hops: probe.route.hops,
        lnd: getLnd.lnd,
        logger: args.logger,
        max: args.find_max,
      },
      cbk);
    }],

    // If there is a successful route, pay it
    pay: ['getLnd', 'probe', 'to', ({getLnd, probe, to}, cbk) => {
      if (!args.is_real_payment) {
        return cbk();
      }

      if (!probe.route) {
        return cbk();
      }

      if (args.max_fee !== undefined && probe.route.fee > args.max_fee) {
        return cbk([400, 'MaxFeeTooLow', {required_fee: probe.route.fee}]);
      }

      args.logger.info({paying: probe.route.hops.map(({channel}) => channel)});

      return payViaRoutes({
        id: to.id,
        lnd: getLnd.lnd,
        routes: [probe.route],
      },
      cbk);
    }],

    // Outcome of probes and payment
    outcome: ['getMax', 'pay', 'probe', ({getMax, pay, probe}, cbk) => {
      if (!probe.route) {
        return cbk(null, {attempted_paths: probe.attempted_paths});
      }

      const {route} = probe;

      return cbk(null, {
        fee: !route ? undefined : route.fee,
        latency_ms: !route ? undefined : probe.latency_ms,
        route_maximum: !getMax ? undefined : getMax.maximum,
        paid: !pay ? undefined : pay.tokens,
        preimage: !pay ? undefined : pay.secret,
        probed: !!pay ? undefined : route.tokens - route.fee,
        success: !route ? undefined : route.hops.map(({channel}) => channel),
      });
    }],
  },
  returnResult({of: 'outcome'}, cbk));
};
