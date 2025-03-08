async function getUserInformationBasedOnPhoneNumber(phoneNumber) {
  return new Promise((resolve, reject) => {
    // mock api call
    const user = {
      name: "Shuti",
    };
    // do I need to wait for 1 second?
    setTimeout(() => {
      // do I need return resolve?
      return resolve(user);
    }, 1000);
  });
}

export { getUserInformationBasedOnPhoneNumber };
