const test = require('node:test');
const assert = require('node:assert/strict');
const { RETURN_REWARD_MULTIPLIER, boostReturnReward, returnRewardEvent } = require('../src/rewards/return-event');

test('Boost Retour 2.0 : double toutes les récompenses entières',()=>{
  assert.equal(RETURN_REWARD_MULTIPLIER,2);
  assert.equal(boostReturnReward(20),40);
  assert.equal(boostReturnReward(100),200);
  assert.deepEqual(returnRewardEvent(),{active:true,multiplier:2,label:'BOOST RETOUR 2.0'});
});
