/* Shared qualification choices for Staff, My Details and server validation. */
(function(root){
  'use strict';
  const choices=Object.freeze({
    academicQualification:Object.freeze(['SSCE/WACCE',"O'Level/A' Level",'Diploma','HND',"Bachelor's Degree",'Postgraduate Diploma',"Master's Degree",'PhD','Other']),
    professionalQualification:Object.freeze(["Teacher's Certificate",'Diploma in Basic Education','Bachelor of Education','Postgraduate teaching qualification','Other'])
  });
  const api=Object.freeze({choices,options:key=>(choices[key]||[]).map(value=>[value,value]),valid:(key,value)=>value===''||choices[key]?.includes(value)===true});
  if(typeof module==='object'&&module.exports)module.exports=api;else root.StaffQualifications=api;
})(typeof globalThis!=='undefined'?globalThis:this);
