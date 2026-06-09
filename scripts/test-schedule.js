const fs = require('fs');
const { parseStructuredHtmlSchedule } = require('../src/schedule');
const { resolveChannelStream } = require('../src/dlhd');

const html = fs.readFileSync('tmp-dlhd.html', 'utf8');
const events = parseStructuredHtmlSchedule(html);
const active = events.filter(e => {
  const now = Math.floor(Date.now() / 1000);
  return e.startTs >= now - 3 * 3600 && e.startTs <= now + 24 * 3600;
});

console.log('parsed', events.length, 'active-window', active.length);
const fr = events.find(e => e.title.includes('France vs Northern Ireland'));
console.log('france event', fr && { title: fr.title, channels: fr.channels.length, start: fr.startTs });
if (fr) {
  const ch = fr.channels.find(c => c.channel_name.includes('BBC3')) || fr.channels[0];
  console.log('testing channel', ch);
  resolveChannelStream(ch.channel_id, ch.channel_name).then(r => console.log('stream', r));
}
