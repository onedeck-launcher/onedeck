// OneDeck identity: two stacked cards with no outlines (a teal card in front with a play button, a deeper teal one
// tucked behind it). Builds SVG/PNG/ICO exports into ui/assets/brand.
// Run: npx electron scripts/build-onedeck-brand.cjs
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..'),brand=path.join(root,'ui/assets/brand');fs.mkdirSync(brand,{recursive:true});
app.setPath('sessionData',path.join(os.tmpdir(),'OneDeck-brand-'+process.pid));

const NAVY=['#16314d','#0b1a2c','#060d18'],SEA='#5fd6cc',FONT='Segoe UI,Arial,sans-serif';
// The two cards and the play button, in a 120-unit square; VIEW frames them centred.
const BACK='<rect x="33" y="17" width="56" height="78" rx="9"',FRONT='<rect x="26" y="24" width="56" height="78" rx="9"';
const PLAY='M47.5 51 L67.5 63 L47.5 75 Z',VIEW='12.5 14.5 90 90';
const mark=(id,play=NAVY[1])=>`<defs><linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#8af2e4"/><stop offset="1" stop-color="${SEA}"/></linearGradient></defs>`+
  `${BACK} fill="#46b5aa"/>${FRONT} fill="url(#${id}g)"/><path d="${PLAY}" fill="${play}" stroke="${play}" stroke-width="4" stroke-linejoin="round"/>`;
// One colour (currentColor), for masks and single-colour uses: a gap cut around the front card, the play button cut out.
const mono=`<mask id="kb" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120"><rect width="120" height="120" fill="#fff"/>${FRONT} fill="#000" stroke="#000" stroke-width="6"/></mask>`+
  `<mask id="kp" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120">${FRONT} fill="#fff"/><path d="${PLAY}" fill="#000" stroke="#000" stroke-width="4" stroke-linejoin="round"/></mask>`+
  `${BACK} fill="currentColor" mask="url(#kb)"/>${FRONT} fill="currentColor" mask="url(#kp)"/>`;
const svg=(viewBox,content,extra='role="img"')=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" ${extra}>${content}</svg>`;
const nested=(id,x,y,s)=>`<svg x="${x}" y="${y}" width="${s}" height="${s}" viewBox="${VIEW}">${mark(id)}</svg>`;
const markSvg=svg(VIEW,mark('m'));
const monoSvg=svg(VIEW,mono);
const iconSvg=svg('0 0 256 256',`<defs><linearGradient id="tile" x2=".7" y2="1"><stop stop-color="${NAVY[0]}"/><stop offset=".55" stop-color="${NAVY[1]}"/><stop offset="1" stop-color="${NAVY[2]}"/></linearGradient><radialGradient id="glow" cx=".5" cy=".5" r=".55"><stop stop-color="${SEA}" stop-opacity=".22"/><stop offset="1" stop-color="${SEA}" stop-opacity="0"/></radialGradient><linearGradient id="rim" x2=".65" y2="1"><stop stop-color="#ffffff50"/><stop offset=".5" stop-color="#ffffff08"/><stop offset="1" stop-color="#ffffff18"/></linearGradient></defs>`+
  `<rect x="2" y="2" width="252" height="252" rx="58" fill="url(#tile)" stroke="url(#rim)" stroke-width="2"/><rect x="4" y="4" width="248" height="248" rx="56" fill="url(#glow)"/>`+nested('i',30,30,196));
// ONE light, DECK bold, white.
const word=(x,y,size,fill='#fff')=>`<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" letter-spacing="${size*.2}" fill="${fill}"><tspan font-weight="300">ONE</tspan><tspan font-weight="700">DECK</tspan></text>`;
const wordmarkSvg=svg('0 0 860 160',nested('w',4,8,144)+word(170,108,72));
// Repo banner: LAUNCHER small under the end of DECK, the tagline below.
const bannerSvg=svg('0 0 1280 420',`<defs><linearGradient id="back" x2="1" y2="1"><stop stop-color="${NAVY[0]}"/><stop offset="1" stop-color="${NAVY[2]}"/></linearGradient></defs><rect width="1280" height="420" rx="24" fill="url(#back)"/>`+
  nested('b',236,112,150)+word(410,222,92)+
  `<text x="960" y="256" text-anchor="end" font-family="${FONT}" font-size="20" font-weight="700" letter-spacing="7" fill="${SEA}">LAUNCHER</text>`+
  `<text x="640" y="320" text-anchor="middle" font-family="${FONT}" font-size="33" font-weight="600" fill="#d5ece9">Ports. ROMs. Emulators. All in one place.</text>`);
const files={'onedeck-mark.svg':markSvg,'onedeck-mark-mono.svg':monoSvg,'onedeck-icon.svg':iconSvg,'onedeck-wordmark.svg':wordmarkSvg,'onedeck-banner.svg':bannerSvg};
for(const [name,data]of Object.entries(files))fs.writeFileSync(path.join(brand,name),data+'\n');

app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true,offscreen:true}});
  try{
    await win.loadURL('data:text/html,<html><body></body></html>');
    const exported=await win.webContents.executeJavaScript(`(async()=>{
      const results=[];async function render(svg,w,h,name){const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await img.decode();const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,w,h);results.push({name,data:c.toDataURL('image/png').split(',')[1]})}
      for(const size of [16,24,32,48,64,128,256,512,1024])await render(${JSON.stringify(iconSvg)},size,size,'onedeck-icon-'+size+'.png');
      await render(${JSON.stringify(markSvg)},512,512,'onedeck-mark.png');await render(${JSON.stringify(wordmarkSvg)},1720,320,'onedeck-wordmark.png');await render(${JSON.stringify(bannerSvg)},1280,420,'onedeck-banner.png');return results;
    })()`);
    for(const e of exported)fs.writeFileSync(path.join(brand,e.name),Buffer.from(e.data,'base64'));
    const sizes=[16,24,32,48,64,128,256],images=sizes.map(size=>fs.readFileSync(path.join(brand,'onedeck-icon-'+size+'.png'))),header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
    images.forEach((image,i)=>{const size=sizes[i],start=6+16*i;header[start]=size===256?0:size;header[start+1]=size===256?0:size;header.writeUInt16LE(1,start+4);header.writeUInt16LE(32,start+6);header.writeUInt32LE(image.length,start+8);header.writeUInt32LE(offset,start+12);offset+=image.length});
    fs.writeFileSync(path.join(brand,'onedeck.ico'),Buffer.concat([header,...images]));
    console.log('OneDeck brand: 5 SVGs, 12 PNGs, 7-size ICO.');app.exit(0);
  }catch(e){console.error(e);app.exit(1)}
});
