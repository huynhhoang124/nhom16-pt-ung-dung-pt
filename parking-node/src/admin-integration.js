const {readFileSync}=require('node:fs');
const path=require('node:path');
const {decodeAdmin,dispatchAdminIn}=require('./admin-commands');

// Dependency injection avoids shipping a second inbox implementation while PD-02 is unmerged.
async function startAdminCommands({makeCommandProcessor,startCommandConsumer,...options}) {
  if(makeCommandProcessor?.supportsCustomDispatch!==true || typeof startCommandConsumer!=='function')throw new Error('PD04_REQUIRES_PD02_DISPATCH_EXTENSION');
  await options.pool.query(readFileSync(path.join(__dirname,'admin-schema.sql'),'utf8'));
  const decode=(...args)=>{try{return decodeAdmin(...args);}catch(error){
    const {InvalidCommand}=require('./commands');
    throw new InvalidCommand(error.message);
  }};
  const processCommand=makeCommandProcessor({...options,decode,dispatchCommand:dispatchAdminIn});
  return startCommandConsumer({...options,queue:`cmd.${options.parkingId}.admin`,prefetch:4,processCommand});
}
module.exports={startAdminCommands};
