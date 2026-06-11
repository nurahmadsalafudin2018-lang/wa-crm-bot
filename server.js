const express=require('express');
const app=express();
app.get('/',(req,res)=>res.json({status:'ok'}));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log('Running on',PORT));
