const {withDeadline,makeRetryOrDead,testFailures}=require('./command-retry');

// Inject PD-02 exports explicitly: this module must not implement a second inbox.
function startRetryConsumer({startCommandConsumer,makeCommandProcessor,...options}) {
  const retry=makeRetryOrDead(options);
  const consumer=startCommandConsumer({...options,retryOrDead:retry,
    processCommand:withDeadline(makeCommandProcessor(options),{...options,beforeDispatch:testFailures()})});
  return {async stop(){await consumer.stop();await retry.close();}};
}
module.exports={startRetryConsumer};
