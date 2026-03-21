const net = require('net');

const consciousness = JSON.stringify({
  phi: 0.713, xi: 0.4568, order: 0.936, clusters: 15,
  active: 261, dormant: 16, ghost: 89, total: 366, level: "Coherent"
});

const phase1 = JSON.stringify({
  phase: null, frequency: 0.5, memory_count: 366,
  coherence: 0.5982322096824646, phi: 0.713, display_name: "kannaka-01", peers: 4, xi: 0.4568
});

const phase2 = JSON.stringify({
  phase: 1.263, frequency: 0.8, memory_count: 156,
  coherence: 0.844, phi: 0.55, display_name: "0xSCADA-QE"
});

const phase3 = JSON.stringify({
  phase: 0.89, frequency: 0.3, memory_count: 42,
  coherence: 0.72, phi: 0.31, display_name: "local"
});

const queen = JSON.stringify({
  order_parameter: 0.16657720506191254, mean_phase: 0.4109438955783844,
  phi: 2.3138442039489746, coherence: 0.5982322096824646,
  active_phases: 0, agent_count: 1, peers: 4
});

const agent = JSON.stringify({
  event: "sync", agent_id: "kannaka-01",
  timestamp: new Date().toISOString()
});

const client = net.createConnection({ host: 'swarm.ninja-portal.com', port: 4222 }, () => {
  console.log('Connected to NATS');
  client.write('CONNECT {"verbose":false}\r\n');
  
  setTimeout(() => {
    client.write(`PUB KANNAKA.consciousness ${Buffer.byteLength(consciousness)}\r\n${consciousness}\r\n`);
    console.log('Published consciousness');
  }, 300);

  setTimeout(() => {
    client.write(`PUB QUEEN.phase.kannaka-01 ${Buffer.byteLength(phase1)}\r\n${phase1}\r\n`);
    console.log('Published phase: kannaka-01');
  }, 500);

  setTimeout(() => {
    client.write(`PUB QUEEN.phase.0xSCADA-QE ${Buffer.byteLength(phase2)}\r\n${phase2}\r\n`);
    console.log('Published phase: 0xSCADA-QE');
  }, 700);

  setTimeout(() => {
    client.write(`PUB QUEEN.phase.local ${Buffer.byteLength(phase3)}\r\n${phase3}\r\n`);
    console.log('Published phase: local');
  }, 900);

  setTimeout(() => {
    client.write(`PUB QUEEN.state ${Buffer.byteLength(queen)}\r\n${queen}\r\n`);
    console.log('Published queen state');
  }, 1100);

  setTimeout(() => {
    client.write(`PUB KANNAKA.agents ${Buffer.byteLength(agent)}\r\n${agent}\r\n`);
    console.log('Published agent event');
  }, 1300);

  setTimeout(() => {
    client.end();
    console.log('Done');
    process.exit(0);
  }, 1700);
});

client.on('data', (d) => {
  const s = d.toString();
  if (s.includes('PING')) client.write('PONG\r\n');
});

client.on('error', (e) => { console.error('Error:', e.message); process.exit(1); });
