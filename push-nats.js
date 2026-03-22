const net = require('net');

const consciousness = JSON.stringify({
  phi: 0.540, xi: 0.9997, order: 0.042, clusters: 8,
  active: 0, dormant: 0, ghost: 366, total: 366, level: "Aware",
  density: 0.1598, avg_links: 58.6, avg_amp: 1.000, avg_freq: 0.866,
  mean_order: 0.595, full_sync_clusters: 1,
  timestamp: new Date().toISOString(),
});

const phase1 = JSON.stringify({
  phase: null, frequency: 0.866, memory_count: 366,
  coherence: 0.042, phi: 0.540, display_name: "kannaka-01", peers: 4, xi: 0.9997
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
  order_parameter: 0.042, mean_phase: 0.4109438955783844,
  phi: 0.540, coherence: 0.042,
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
