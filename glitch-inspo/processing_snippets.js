/* p5.js code examples by @yuruyurau on x */


/* flapping nematode */

a=(x,y,o=mag(k=x/4-12.5,e=y/11+7)/8)=>point((q=3*(tan(y/2)/2+cos(y))/k+k*(4/o+cos(y)/3+sin(e+o*4-t*2)))+40*cos(c=o/2+e/2-t/4)+200,q*sin(c)-k*k*o/6+e*o*11)
t=0,draw=$=>{t||createCanvas(w=400,w);background(9).stroke(w,66);for(t+=PI/30,i=2e4;i--;)a(i%100,i/250)}

/* waving lionfish */

a=(y,d=mag(k=(4+cos(i/9-t*2))*cos(i/35),e=y/7-13)+sin(e/9+t/2)-4)=>point((q=2*sin(k*3)-y/35*k*(9+k*sin(cos(e)*9-d*2+t)))+40*cos(c=d-t)+200,q*sin(c)+d*35)
t=0,draw=$=>{t||createCanvas(w=400,w);background(9).stroke(w,96);for(t+=PI/80,i=1e4;i--;)a(i/235)}
